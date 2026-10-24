import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { FileJournalStore, ensurePrivateDir, readJson, requirePrivateFile, withFileLock, writePrivate } from "./file-store.mjs";
import { frontendAt, resolveSdkRoot } from "./runtime.mjs";

const unresolved = new Set(["prepared", "exported", "unknown", "submitted"]);
const intentFields = Object.freeze({
  send: ["asset", "amount", "recipient"],
  unshield: ["asset", "amount", "recipient"],
  withdraw: ["asset", "amount", "recipient"],
  consolidate: ["asset"],
  mint: ["asset", "amount", "count"],
  place: ["asset", "amount"],
  fill: ["asset", "amount"],
  sweep: ["asset", "amount", "fills", "minBought", "protocolFee"],
  release: ["asset", "orderId", "nonce"],
  void: ["asset", "originalId", "voids"],
});

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${label}`);
  return value;
}
function decimal(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`invalid ${label}`);
  return BigInt(value);
}
function safeInteger(value, label) {
  const result = Number(decimal(value, label));
  if (!Number.isSafeInteger(result)) throw new Error(`invalid ${label}`);
  return result;
}
function asset(value) {
  if (value === "0" || value === "token") return 0;
  if (value === "1" || value === "native") return 1;
  throw new Error("asset must be token/0 or native/1");
}
const TOKEN_DUST = 1_000_000_000n;
const NATIVE_DUST = 10_000n;
export function validateMarketOrderAmounts(sellAssetValue, sellAmountValue, buyAmountValue) {
  const sellAsset = asset(sellAssetValue);
  const sellAmount = decimal(sellAmountValue, "sellAmount");
  const buyAmount = decimal(buyAmountValue, "buyAmount");
  const sellDust = sellAsset === 0 ? TOKEN_DUST : NATIVE_DUST;
  const buyDust = sellAsset === 0 ? NATIVE_DUST : TOKEN_DUST;
  if (sellAmount <= sellDust || buyAmount <= buyDust) {
    throw new Error(`MARKET_ORDER_BELOW_DUST: sell amount must be greater than ${sellDust} raw units and buy amount must be greater than ${buyDust} raw units`);
  }
  return { sellAsset, sellAmount, buyAmount };
}

/** Validate a fill against the current public order before generating a proof. */
export async function validateFillOrder(ctx, opts) {
  const orderId = decimal(opts.orderId, "orderId");
  const sellAsset = asset(opts.sellAsset);
  const pay = decimal(opts.pay, "pay");
  let order;
  try { [order] = await ctx.sdk.trading.readFreshMarketOrders(ctx.connection, [orderId]); }
  catch { throw new Error("MARKET_ORDER_NOT_FOUND: the selected order does not exist"); }
  if (!order || order.id !== orderId) throw new Error("MARKET_ORDER_NOT_FOUND: the selected order does not exist");
  if (!order.open) throw new Error("MARKET_ORDER_CLOSED: the selected order is no longer open");
  if (order.sellAsset !== sellAsset) throw new Error("MARKET_ORDER_ASSET_MISMATCH: --sell-asset must match the order's sell asset");
  const marketAbi = ctx.sdk.viem.parseAbi(["function dust(uint32 asset) view returns (uint64)"]);
  const sellDust = await ctx.connection.client.readContract({
    address: ctx.config.contracts.market, abi: marketAbi, functionName: "dust", args: [sellAsset],
  });
  const bought = pay * order.sellAmount / order.buyAmount;
  if (bought <= 0n) throw new Error("MARKET_FILL_BAD_AMOUNT: payment rounds to zero output");
  if (bought > order.remaining) throw new Error("MARKET_FILL_TOO_MUCH: payment exceeds the order remaining amount");
  const residual = order.remaining - bought;
  if (residual > 0n && residual <= BigInt(sellDust)) throw new Error(`MARKET_FILL_LEAVES_DUST: remaining order amount would be at or below ${sellDust} raw units`);
  return { orderId, sellAsset, pay, order, bought };
}
function pathFrom(root, value) { return isAbsolute(value) ? value : resolve(root, value); }
function packetHash(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }
export function parseIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string") throw new Error("invalid packet intent sidecar");
  const fields = intentFields[value.kind];
  if (!fields) throw new Error("unsupported packet intent sidecar");
  const allowed = new Set(["kind", ...fields]);
  if (Object.keys(value).some(key => !allowed.has(key)) || fields.some(key => typeof value[key] !== "string")) {
    throw new Error("invalid packet intent sidecar");
  }
  const kind = value.kind === "unshield" ? "withdraw" : value.kind;
  return Object.fromEntries([["kind", kind], ...fields.map(key => [key, value[key]])]);
}

export function preparationResult(action, opts, saved) {
  if (saved) return saved;
  throw new Error("SDK did not export an authorization packet");
}

function cancellationFor(records, originalId, statuses) {
  return records.filter(record => record.intent?.kind === "void" && record.intent.originalId === originalId
    && (!statuses || statuses.has(record.status))).sort((left, right) => left.createdAt - right.createdAt)[0];
}

export async function prepareVoid(session, journalId, { exportAuthorization, isExported }) {
  const existing = cancellationFor(session.pendingTransactions(), journalId, unresolved);
  if (existing) {
    await session.sync();
    const records = session.pendingTransactions();
    const current = cancellationFor(records, journalId, unresolved);
    if (!current) {
      const terminal = cancellationFor(records, journalId, new Set(["observed", "conflicted"]));
      if (terminal) return { packet: null, journalId: terminal.id, originalJournalId: journalId,
        operation: "void", exported: false, status: terminal.status };
    } else if (["prepared", "exported"].includes(current.status) && typeof current.authorization === "string") {
      const wasPrepared = current.status === "prepared";
      if (wasPrepared) await session.journal.mark(current.id, "exported");
      const exported = session.journal.get(current.id);
      try {
        await exportAuthorization(exported.authorization, exported);
      } catch (error) {
        if (wasPrepared) {
          try {
            await session.journal.mark(current.id, "prepared");
            await session.journal.discardPrepared(current.id);
          } catch { /* retain the original export error for explicit recovery */ }
        }
        throw error;
      }
      return undefined;
    } else {
      throw new Error(`VOID_ALREADY_PENDING: cancellation ${current.id} is ${current.status}; inspect history or status before any further action`);
    }
  }

  await session.void(journalId);
  if (isExported()) return undefined;
  try {
    const original = session.journal.get(journalId);
    if (["observed", "conflicted"].includes(original.status)) {
      return { packet: null, journalId, operation: "void", exported: false, status: original.status };
    }
  } catch (error) {
    if (/unknown transaction journal entry/i.test(String(error?.message))) {
      return { packet: null, originalJournalId: journalId, operation: "void", exported: false, status: "discarded" };
    }
    throw error;
  }
  throw new Error("VOID_ALREADY_PENDING: cancellation outcome is unresolved; inspect history or status before any further action");
}

const moduleUrl = (frontend, path) => pathToFileURL(join(frontend, path)).href;

/** Load the repository-vendored SDK. Run Node with --experimental-strip-types. */
export async function loadSdk(root) {
  const base = await resolveSdkRoot(root);
  const frontend = await frontendAt(base);
  const [wallet, config, client, crypto404, session, portable, prover, amount, trading, abi, viem] = await Promise.all([
    import(moduleUrl(frontend, "src/wallet/index.ts")),
    import(moduleUrl(frontend, "src/config/index.ts")),
    import(moduleUrl(frontend, "src/chain/client.ts")),
    import(moduleUrl(frontend, "src/crypto/index.ts")),
    import(moduleUrl(frontend, "src/flows/session.ts")),
    import(moduleUrl(frontend, "src/flows/portable.ts")),
    import(moduleUrl(frontend, "src/prover/index.ts")),
    import(moduleUrl(frontend, "src/chain/amount.ts")),
    import(moduleUrl(frontend, "src/chain/trading.ts")),
    import(moduleUrl(frontend, "src/abi/index.ts")),
    import(moduleUrl(frontend, "node_modules/viem/_esm/index.js")),
  ]);
  return { root: base, frontend, wallet, config, client, crypto: crypto404, session, portable, prover, amount, trading, abi, viem };
}

export async function loadConfig(sdk, configPath) {
  if (!configPath) throw new Error("BSC mainnet is not configured: provide a local public config file");
  const input = await readJson(pathFrom(sdk.root, configPath));
  if (input?.chainId !== 56) throw new Error("only BSC mainnet chain 56 is supported");
  if (!input.deployment) throw new Error("BSC mainnet is not configured: deployment is missing");
  return sdk.config.create404Config({
    ...input,
    chainId: 56,
    deployBlock: decimal(String(input.deployBlock), "deployBlock"),
    ...(input.marketBlock === undefined ? {} : { marketBlock: decimal(String(input.marketBlock), "marketBlock") }),
  });
}

const LOG_RANGE_LIMIT = 5_000n;
const READ_RETRIES = 3;
const READ_RETRYABLE = /timeout|timed out|temporar|rate limit|too many requests|429|503|502|504|connection reset|socket hang up|network error/i;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readWithRetry(operation, args) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(args); }
    catch (error) {
      if (attempt >= READ_RETRIES || !READ_RETRYABLE.test(String(error))) throw error;
      await pause(100 * 2 ** (attempt - 1));
    }
  }
}

function blockNumber(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0x[0-9a-f]+|\d+)$/i.test(value)) return BigInt(value);
  return null;
}

/** Keep public-RPC log requests bounded, shrinking the range when a provider has a lower cap. */
export async function openPool(sdk, config) {
  const connection = await sdk.client.openPool(config);
  const client = connection.client;
  if (!client) return connection;
  if (typeof client.getLogs === "function") {
    const original = client.getLogs.bind(client);
    client.getLogs = async args => {
    const from = blockNumber(args?.fromBlock);
    const to = blockNumber(args?.toBlock);
    if (args?.blockHash !== undefined || from === null || to === null || to < from || to - from + 1n <= LOG_RANGE_LIMIT) {
      return readWithRetry(original, args);
    }
    const logs = [];
    let span = LOG_RANGE_LIMIT;
    for (let start = from; start <= to;) {
      const end = start + span - 1n < to ? start + span - 1n : to;
      try {
        logs.push(...await readWithRetry(original, { ...args, fromBlock: start, toBlock: end }));
        start = end + 1n;
      } catch (error) {
        if (span > 1n && /range|too many|response size|result limit/i.test(String(error))) {
          span = span / 2n || 1n;
          continue;
        }
        throw error;
      }
    }
    return logs;
    };
  }
  for (const method of ["getBlock", "getCode", "getChainId", "readContract"]) {
    if (typeof client[method] !== "function") continue;
    const originalMethod = client[method].bind(client);
    client[method] = args => readWithRetry(originalMethod, args);
  }
  return connection;
}

export async function doctor({ root, configPath, config } = {}) {
  let sdk;
  try { sdk = await loadSdk(root); }
  catch (error) { return { ok: false, dependencies: false, configured: false, chainId: 56, error: error.message }; }
  const selected = configPath ?? config;
  if (!selected) return { ok: false, dependencies: true, configured: false, chainId: 56, status: "not configured" };
  try {
    const parsed = await loadConfig(sdk, selected);
    return { ok: true, dependencies: true, configured: true, chainId: parsed.chain.id, pool: parsed.contracts.pool };
  } catch (error) {
    return { ok: false, dependencies: true, configured: false, chainId: 56, error: error.message };
  }
}

async function password(opts) {
  let value;
  if (typeof opts.password === "string") value = opts.password;
  else if (opts.passwordFile) {
    const path = pathFrom(opts.root, opts.passwordFile);
    value = (await requirePrivateFile(path, "password file")).replace(/[\r\n]+$/, "");
  } else {
    throw new Error("PASSWORD_REQUIRED: use a hidden local prompt or a 0600 password file");
  }
  if (value.length < 8) throw new Error("wallet password must contain at least 8 characters");
  return value;
}
async function requireWalletDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw new Error("wallet directory must have mode 0700");
}
async function loadSeed(sdk, opts) {
  const directory = pathFrom(opts.root, required(opts.wallet, "wallet"));
  await requireWalletDirectory(directory);
  const serialized = await requirePrivateFile(join(directory, "vault.json"), "wallet vault");
  let vault;
  try { vault = JSON.parse(serialized); } catch { throw new Error("wallet vault is not valid JSON"); }
  return sdk.wallet.decryptSeed(sdk.wallet.parseWalletFile(vault), await password(opts));
}
function addressIndex(value) {
  if (value === undefined) return 0;
  const index = safeInteger(value, "addressIndex");
  if (index < 0 || index > 255) throw new Error("invalid addressIndex");
  return index;
}
function privateAddress(sdk, seed, index = 0) {
  const keys = sdk.crypto.deriveKeys(seed);
  return sdk.crypto.encodePrivateAddress(sdk.crypto.deriveAddress(keys, sdk.crypto.deriveBytes(keys.seed, `pm/address/${index}`, 11)));
}

export async function walletCommand(action, opts) {
  const sdk = await loadSdk(opts.root);
  opts = { ...opts, root: sdk.root };
  const selectedAddressIndex = addressIndex(opts.addressIndex);
  const directory = pathFrom(sdk.root, required(opts.wallet, "wallet"));
  if (action === "create" || action === "import") {
    const secretPassword = await password(opts);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code === "EEXIST") throw new Error("wallet already exists; refusing to overwrite it"); throw error; }
    await ensurePrivateDir(directory);
    try {
      const seed = action === "create"
        ? randomBytes(32)
        : sdk.wallet.restoreMnemonicBackup(await requirePrivateFile(pathFrom(sdk.root, required(opts.mnemonicFile, "mnemonicFile")), "mnemonic file"));
      const encrypted = await sdk.wallet.encryptSeed(seed, secretPassword);
      await writePrivate(join(directory, "vault.json"), `${JSON.stringify(encrypted, null, 2)}\n`, { exclusive: true });
      if (action === "create" && opts.mnemonicFile) {
        await writePrivate(pathFrom(sdk.root, opts.mnemonicFile), `${sdk.wallet.createMnemonicBackup(seed)}\n`, { exclusive: true });
      }
      const address = privateAddress(sdk, seed, selectedAddressIndex); seed.fill(0);
      return { wallet: directory, address, addressIndex: selectedAddressIndex, backupWritten: Boolean(action === "create" && opts.mnemonicFile) };
    } catch (error) {
      // Keep a created directory as an unmistakable failed/partial wallet; never reuse it silently.
      throw error;
    }
  }
  if (action === "address") {
    const seed = await loadSeed(sdk, opts);
    try { return { address: privateAddress(sdk, seed, selectedAddressIndex), addressIndex: selectedAddressIndex }; }
    finally { seed.fill(0); }
  }
  throw new Error(`unsupported wallet action: ${action}`);
}

async function context(opts, { prover = false, onAuthorization } = {}) {
  const sdk = await loadSdk(opts.root);
  opts = { ...opts, root: sdk.root };
  const config = await loadConfig(sdk, required(opts.config, "config"));
  const connection = await openPool(sdk, config);
  const seed = await loadSeed(sdk, opts);
  const keys = sdk.crypto.deriveKeys(seed);
  const walletDir = pathFrom(sdk.root, required(opts.wallet, "wallet"));
  const journalPath = join(walletDir, `journal-${config.chain.id}-${config.contracts.pool.toLowerCase()}.json`);
  let proof;
  const prove = async () => {
    proof ??= sdk.prover.createProver({ backend: "Wasm", threads: 1, fetchImplementation: localAssetFetch(sdk.frontend) });
    return proof;
  };
  const session = new sdk.session.Protocol404Session(connection, keys, {
    proveTransfer: async inputs => (await prove()).proveTransfer(inputs),
  }, {
    journalStore: new FileJournalStore(journalPath),
    lock: async (_name, operation) => operation(),
    submissionMode: () => "export",
    onAuthorization,
  });
  return { sdk, config, connection, session, destroy: async () => {
    try { if (proof) await (await proof.catch(() => undefined))?.destroy(); }
    finally { keys.seed.fill(0); }
  } };
}

function localAssetFetch(frontend) {
  return async input => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://404.local");
    if (url.origin !== "http://404.local" || !/^\/(assets|crs)\/[A-Za-z0-9._/-]+$/.test(url.pathname) || url.pathname.includes("..")) {
      throw new Error("blocked prover asset path");
    }
    const path = join(frontend, "public", url.pathname);
    const bytes = await readFile(path);
    const type = url.pathname.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
    return new Response(bytes, { status: 200, headers: { "content-type": type } });
  };
}

export function balanceTotals(snapshot, sdk, pending = new Set()) {
  const summarize = selected => {
    const notes = snapshot.unspent.filter(owned => owned.note.asset === selected);
    const available = notes.filter(owned => owned.note.lockUntil <= snapshot.head.timestamp && !pending.has(owned.nf));
    const reserved = notes.filter(owned => pending.has(owned.nf));
    const locked = notes.filter(owned => !pending.has(owned.nf) && owned.note.lockUntil > snapshot.head.timestamp);
    const sum = values => values.reduce((total, owned) => total + owned.note.value, 0n);
    return {
      total: sum(notes).toString(),
      available: sum(available).toString(),
      max: sdk.amount.maxNoteSpend(available.map(owned => owned.note.value)).toString(),
      notes: notes.length,
      availableNotes: available.length,
      reserved: sum(reserved).toString(),
      reservedNotes: reserved.length,
      locked: sum(locked).toString(),
      lockedNotes: locked.length,
    };
  };
  return { token: summarize(0), native: summarize(1) };
}

export async function readCommand(action, opts) {
  const root = await resolveSdkRoot(opts.root);
  opts = { ...opts, root };
  let historyPage;
  if (action === "history") {
    const offset = safeInteger(opts.offset ?? "0", "offset");
    const limit = opts.limit === undefined ? undefined : safeInteger(opts.limit, "limit");
    if (limit !== undefined && limit < 1) throw new Error("limit must be positive");
    historyPage = { offset, ...(limit === undefined ? {} : { limit }) };
  }
  const walletDir = pathFrom(root, required(opts.wallet, "wallet"));
  await requireWalletDirectory(walletDir);
  return withFileLock(join(walletDir, ".prepare.lock"), async () => {
    const ctx = await context(opts);
    try {
      if (action === "balance") {
        const snapshot = await ctx.session.sync();
        return balanceTotals(snapshot, ctx.sdk, ctx.session.journal.unresolvedNullifiers());
      }
      if (action === "history") {
        const snapshot = await ctx.session.sync();
        const { buildHistory } = await import("./history.mjs");
        return await buildHistory({
          root: ctx.sdk.root,
          connection: ctx.connection,
          snapshot,
          records: ctx.session.pendingTransactions(),
          poolEvents: ctx.sdk.abi.rawAbis.pool.filter(entry => entry.type === "event"),
          marketEvents: ctx.sdk.abi.marketAbi(ctx.config.marketVersion).filter(entry => entry.type === "event"),
          orderMaker: index => ctx.session.orderMaker(index),
        }, historyPage);
      }
      if (action === "orders") {
        await ctx.session.journal.load();
        const orders = await ctx.sdk.trading.readMarketOrders(ctx.connection);
        const makers = new Map();
        for (let index = 0; index < 10_000; index++) makers.set(ctx.session.orderMaker(index).toLowerCase(), index);
        return { orders: orders.filter(order => makers.has(order.maker.toLowerCase())).map(order => ({ ...order, id: order.id.toString(), sellAmount: order.sellAmount.toString(), buyAmount: order.buyAmount.toString(), remaining: order.remaining.toString(), proceeds: order.proceeds.toString(), keyIndex: makers.get(order.maker.toLowerCase()) })) };
      }
      throw new Error(`unsupported read action: ${action}`);
    } finally { await ctx.destroy(); }
  });
}

async function sweepRequest(root, opts) {
  const input = await readJson(pathFrom(root, required(opts.fillsFile, "fillsFile")));
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error("fills file must contain 1 to 20 entries");
  const fills = input.map((fill, index) => {
    if (!fill || typeof fill !== "object" || Array.isArray(fill)
      || Object.keys(fill).length !== 2 || !("orderId" in fill) || !("pay" in fill)) throw new Error(`invalid fill at index ${index}`);
    const orderId = decimal(fill.orderId, `fills[${index}].orderId`);
    const pay = decimal(fill.pay, `fills[${index}].pay`);
    if (orderId >= 1n << 256n) throw new Error(`fills[${index}].orderId exceeds uint256`);
    if (pay <= 0n || pay >= 1n << 64n) throw new Error(`fills[${index}].pay must fit positive uint64`);
    return { orderId, pay };
  });
  if (new Set(fills.map(fill => fill.orderId.toString())).size !== fills.length) throw new Error("duplicate orderId in fills file");
  const minBought = decimal(opts.minBought, "minBought");
  const protocolFee = decimal(opts.protocolFee, "protocolFee");
  if (minBought <= 0n || minBought >= 1n << 64n) throw new Error("minBought must fit positive uint64");
  if (protocolFee >= 1n << 64n || fills.reduce((total, fill) => total + fill.pay, protocolFee) >= 1n << 64n) {
    throw new Error("batch payment including fee must fit uint64");
  }
  return { fills, minBought, protocolFee };
}

function pendingMakers(session) {
  const result = new Set();
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    for (const [key, child] of Object.entries(value)) {
      if (key === "maker" && typeof child === "string" && /^0x[0-9a-f]{40}$/i.test(child)) result.add(child.toLowerCase());
      else visit(child);
    }
  };
  for (const record of session.pendingTransactions()) if (record.intent.kind === "place" && unresolved.has(record.status)) visit(record.body);
  return result;
}

async function selectOrderKey(ctx, opts) {
  const orders = await ctx.sdk.trading.readMarketOrders(ctx.connection);
  const used = new Set(orders.map(order => order.maker.toLowerCase()));
  for (const maker of pendingMakers(ctx.session)) used.add(maker);
  if (opts.keyIndex !== undefined) {
    const index = safeInteger(opts.keyIndex, "keyIndex");
    if (index >= 10_000 || used.has(ctx.session.orderMaker(index).toLowerCase())) throw new Error("order key index is already reserved");
    return index;
  }
  for (let index = 0; index < 10_000; index++) if (!used.has(ctx.session.orderMaker(index).toLowerCase())) return index;
  throw new Error("all 10000 deterministic order keys are reserved");
}

export async function prepareCommand(action, opts) {
  if (action === "unshield") action = "withdraw"; // Legacy CLI input only; new output stays Protocol 404 terminology.
  if (!["mint", "send", "withdraw", "merge", "place", "fill", "sweep", "release", "void"].includes(action)) throw new Error(`unsupported prepare action: ${action}`);
  if (action === "void") required(opts.journalId, "journalId");
  const root = await resolveSdkRoot(opts.root);
  opts = { ...opts, root };
  const sweep = action === "sweep" ? await sweepRequest(root, opts) : null;
  const walletDir = pathFrom(root, required(opts.wallet, "wallet"));
  const output = pathFrom(root, required(opts.out, "out"));
  const intentOutput = `${output}.intent.json`;
  // Validate/create the private output directory before spending time on RPC or proving.
  await ensurePrivateDir(dirname(output));
  try { await stat(output); throw new Error("output packet already exists; refusing to overwrite it"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  try { await stat(intentOutput); throw new Error("output intent sidecar already exists; refusing to overwrite it"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  await requireWalletDirectory(walletDir);
  await requirePrivateFile(join(walletDir, "vault.json"), "wallet vault");
  return withFileLock(join(walletDir, ".prepare.lock"), async () => {
    try { await stat(output); throw new Error("output packet already exists; refusing to overwrite it"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { await stat(intentOutput); throw new Error("output intent sidecar already exists; refusing to overwrite it"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    let saved;
    const saveAuthorization = async (text, record) => {
      const packetText = `${text}\n`;
      const intent = parseIntent(sweep ? {
        ...record.intent,
        fills: JSON.stringify(sweep.fills.map(fill => ({ orderId: fill.orderId.toString(), pay: fill.pay.toString() }))),
        minBought: sweep.minBought.toString(),
        protocolFee: sweep.protocolFee.toString(),
      } : record.intent);
      try {
        await writePrivate(output, packetText, { exclusive: true });
        await writePrivate(intentOutput, `${JSON.stringify({ version: 1, packetSha256: packetHash(packetText), journalId: record.id, intent }, null, 2)}\n`, { exclusive: true });
      } catch (error) {
        await unlink(output).catch(() => undefined);
        await unlink(intentOutput).catch(() => undefined);
        throw error;
      }
      saved = { packet: output, journalId: record.id, operation: intent.kind === "consolidate" ? "merge" : intent.kind, exported: true,
        ...(intent.kind === "void" ? { originalJournalId: intent.originalId } : {}) };
    };
    const ctx = await context(opts, { prover: true, onAuthorization: saveAuthorization });
    try {
      await ctx.session.journal.load();
      if (action === "mint") {
        const info = await ctx.sdk.client.readPoolInfo(ctx.connection);
        await ctx.session.privateMint({ count: 1, lot: info.lot, priceWei: info.price });
      } else if (action === "send") {
        const to = ctx.sdk.crypto.decodePrivateAddress(required(opts.to, "to"));
        await ctx.session.send({ to, amount: ctx.sdk.amount.parseNoteAmount(required(opts.amount, "amount")), asset: asset(opts.asset) });
      } else if (action === "withdraw") {
        await ctx.session.withdraw({ recipient: required(opts.to, "to"), amount: ctx.sdk.amount.parseNoteAmount(required(opts.amount, "amount")), asset: asset(opts.asset) });
      } else if (action === "merge") {
        await ctx.session.consolidate({ asset: asset(opts.asset) });
      } else if (action === "place") {
        validateMarketOrderAmounts(opts.sellAsset, opts.sellAmount, opts.buyAmount);
        const keyIndex = await selectOrderKey(ctx, opts);
        await ctx.session.placeOrder({ sellAsset: asset(opts.sellAsset), sellAmount: decimal(opts.sellAmount, "sellAmount"), buyAmount: decimal(opts.buyAmount, "buyAmount"), keyIndex });
      } else if (action === "fill") {
        if (opts.protocolFee === undefined) throw new Error("protocolFee is required and must be reviewed explicitly");
        const fill = await validateFillOrder(ctx, opts);
        await ctx.session.fillOrder({ orderId: fill.orderId, sellAsset: fill.sellAsset, pay: fill.pay, protocolFee: decimal(opts.protocolFee, "protocolFee") });
      } else if (action === "sweep") {
        await ctx.session.sweepOrders(sweep);
      } else if (action === "release") {
        const releaseAction = Number(decimal(opts.action, "action"));
        if (releaseAction !== 0 && releaseAction !== 1) throw new Error("release action must be 0 or 1");
        await ctx.session.releaseOrder({ orderId: decimal(opts.orderId, "orderId"), action: releaseAction, asset: asset(opts.asset), keyIndex: safeInteger(opts.keyIndex, "keyIndex"), nonce: safeInteger(opts.nonce, "nonce"), ...(opts.until ? { deadline: decimal(opts.until, "until") } : {}) });
      } else {
        const noPacket = await prepareVoid(ctx.session, opts.journalId, {
          exportAuthorization: saveAuthorization,
          isExported: () => Boolean(saved),
        });
        if (noPacket) return noPacket;
      }
      return preparationResult(action, opts, saved);
    } finally { await ctx.destroy(); }
  });
}

export async function inspectCommand(opts) {
  const sdk = await loadSdk(opts.root);
  const configPath = required(opts.config, "config");
  const publicConfig = await readJson(pathFrom(sdk.root, configPath));
  const config = await loadConfig(sdk, configPath);
  const connection = { config };
  const packetPath = pathFrom(sdk.root, required(opts.packet, "packet"));
  const text = await readFile(packetPath, "utf8");
  const packet = sdk.portable.parseAuthorization(connection, text);
  const description = sdk.portable.describeAuthorization(connection, text);
  const call = sdk.portable.encodeWalletAction(connection, packet.path, packet.body);
  let intent = null;
  let journalId = null;
  try {
    const serialized = await requirePrivateFile(`${packetPath}.intent.json`, "packet intent sidecar");
    let sidecar;
    try { sidecar = JSON.parse(serialized); } catch { throw new Error("packet intent sidecar is not valid JSON"); }
    if (sidecar?.version !== 1 || sidecar.packetSha256 !== packetHash(text)
      || typeof sidecar.journalId !== "string" || !/^[0-9a-f]{32}$/.test(sidecar.journalId)) {
      throw new Error("packet intent sidecar does not match this authorization");
    }
    intent = parseIntent(sidecar.intent);
    journalId = sidecar.journalId;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const operation = intent ? intent.kind === "consolidate" ? "merge" : intent.kind : packet.path.slice(1);
  return { packet: packetPath, id: description.id, journalId, chainId: packet.chainId, pool: packet.pool, target: description.target,
    operation, authorizationPath: packet.path, intent,
    call: { to: call.to, data: call.data, value: call.value.toString() }, config: publicConfig };
}

/** Revalidate the exact packet against BSC and estimate it for BAW preview. Never signs or broadcasts. */
export async function verifySubmission(opts, from) {
  const sdk = await loadSdk(opts.root);
  if (!sdk.viem.isAddress(from, { strict: false })) throw new Error("invalid BAW from address");
  const config = await loadConfig(sdk, required(opts.config, "config"));
  const connection = await openPool(sdk, config);
  const text = await readFile(pathFrom(sdk.root, required(opts.packet, "packet")), "utf8");
  const packet = sdk.portable.parseAuthorization(connection, text);
  const call = sdk.portable.encodeWalletAction(connection, packet.path, packet.body);
  if (packet.path === "/mint") {
    const access = await sdk.client.readNftMintAccess(connection, from);
    if (access.balance === 0n) throw new Error("the BAW submitting wallet must hold the membership NFT");
    if (access.minted >= 10n) throw new Error("the BAW submitting wallet has reached its 10-mint limit");
  }
  const gasEstimate = await connection.client.estimateGas({ ...call, account: from });
  return { gasEstimate: gasEstimate.toString() };
}
