import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { withFileLock, writePrivate } from "./file-store.mjs";
import { balanceTotals, createMarketStore, doctor, loadSdk, openPool, parseIntent, preparationResult, prepareCommand, prepareVoid, readCommand, validateFillOrder, validateMarketOrderAmounts, walletCommand } from "./sdk.mjs";

const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

test("doctor reports an absent BSC deployment as not configured", async () => {
  const result = await doctor({ root });
  assert.equal(result.dependencies, true);
  assert.equal(result.configured, false);
  assert.equal(result.chainId, 56);
  assert.match(result.status, /not configured/);
});

test("public RPC log requests are chunked and retried at a smaller range", async () => {
  const requests = [];
  const client = {
    async getLogs(args) {
      requests.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
      if (args.toBlock - args.fromBlock + 1n > 3_000n) throw new Error("too many results");
      return [{ blockNumber: args.fromBlock }];
    },
  };
  const connection = await openPool({ client: { openPool: async () => ({ client }) } }, {});
  const logs = await connection.client.getLogs({ fromBlock: 0n, toBlock: 8_000n });
  assert.deepEqual(logs.map(log => log.blockNumber), [0n, 2_500n, 5_000n, 7_500n]);
  assert.deepEqual(requests, [
    { fromBlock: 0n, toBlock: 4_999n },
    { fromBlock: 0n, toBlock: 2_499n },
    { fromBlock: 2_500n, toBlock: 4_999n },
    { fromBlock: 5_000n, toBlock: 7_499n },
    { fromBlock: 7_500n, toBlock: 8_000n },
  ]);
});

test("transient RPC reads retry without retrying non-transient failures", async () => {
  let attempts = 0;
  const client = {
    async getLogs() { attempts++; if (attempts < 3) throw new Error("request timeout"); return []; },
  };
  const connection = await openPool({ client: { openPool: async () => ({ client }) } }, {});
  await connection.client.getLogs({ fromBlock: 1n, toBlock: 1n });
  assert.equal(attempts, 3);
});

test("market order amounts are checked above both deployed dust limits", () => {
  assert.throws(() => validateMarketOrderAmounts("token", "100000000", "10001"), /MARKET_ORDER_BELOW_DUST/);
  assert.throws(() => validateMarketOrderAmounts("native", "10001", "1000000000"), /MARKET_ORDER_BELOW_DUST/);
  assert.deepEqual(validateMarketOrderAmounts("token", "200000000000", "196000"), {
    sellAsset: 0, sellAmount: 200000000000n, buyAmount: 196000n,
  });
});

test("market file cache saves the snapshot argument, not the cache key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-market-cache-test-"));
  const path = join(directory, "market.json");
  const store = createMarketStore(path);
  const snapshot = {
    version: 1, block: 123n, hash: `0x${"1".repeat(64)}`,
    orders: [{ id: 0n, sellAsset: 0, open: true, releases: 0, maker: "0x0000000000000000000000000000000000000001", sellAmount: 10n, buyAmount: 20n, remaining: 10n, proceeds: 0n }],
  };
  await store.save("v1:56:market", snapshot);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.block, "123");
  assert.equal(saved.orders[0].id, "0");
  assert.notEqual(saved, "v1:56:market");
  assert.equal((await store.load("v1:56:market")).orders[0].sellAmount, "10");
});

test("fill validation reads the order and rejects mismatched or invalid fills", async () => {
  const order = { id: 7n, sellAsset: 0, open: true, sellAmount: 1_000_000_000_000n, buyAmount: 1_000_000_000_000n, remaining: 2_000_000_000n };
  const ctx = { config: { contracts: { market: "0x0000000000000000000000000000000000000001" } },
    sdk: { trading: { readFreshMarketOrders: async () => [order] }, viem: { parseAbi: value => value } },
    connection: { client: { readContract: async ({ args }) => args[0] === 0 ? 1_000_000_000n : 10_000n } } };
  await assert.rejects(validateFillOrder(ctx, { orderId: "7", sellAsset: "native", pay: "20" }), /MARKET_ORDER_ASSET_MISMATCH/);
  await assert.rejects(validateFillOrder(ctx, { orderId: "7", sellAsset: "token", pay: "1000000000" }), /MARKET_FILL_LEAVES_DUST/);
  const valid = await validateFillOrder(ctx, { orderId: "7", sellAsset: "token", pay: "2000000000" });
  assert.equal(valid.bought, 2000000000n);
});

test("wallet create writes only an encrypted private vault and private backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-wallet-test-"));
  const passwordFile = join(directory, "password");
  const wallet = join(directory, "new-parent", "wallet");
  const mnemonicFile = join(directory, "backup.txt");
  await writeFile(passwordFile, "correct horse battery staple\n", { mode: 0o600 });
  await chmod(passwordFile, 0o600);
  const result = await walletCommand("create", { root, wallet, passwordFile, mnemonicFile });
  const vaultText = await readFile(join(wallet, "vault.json"), "utf8");
  const mnemonic = await readFile(mnemonicFile, "utf8");
  assert.equal(JSON.parse(vaultText).version, 1);
  assert.equal(JSON.stringify(result).includes(mnemonic.trim()), false);
  assert.equal(vaultText.includes(mnemonic.trim()), false);
  assert.match(result.address, /^4041/);
  assert.equal((await stat(wallet)).mode & 0o777, 0o700);
  assert.equal((await stat(join(wallet, "vault.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(mnemonicFile)).mode & 0o777, 0o600);
});

test("wallet addresses support deterministic indexes 0 through 255", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-address-index-test-"));
  const passwordFile = join(directory, "password");
  const wallet = join(directory, "wallet");
  await writeFile(passwordFile, "correct horse battery staple\n", { mode: 0o600 });
  const created = await walletCommand("create", { root, wallet, passwordFile });
  const first = await walletCommand("address", { root, wallet, passwordFile });
  const second = await walletCommand("address", { root, wallet, passwordFile, addressIndex: "1" });
  const last = await walletCommand("address", { root, wallet, passwordFile, addressIndex: "255" });
  assert.equal(first.addressIndex, 0);
  assert.equal(first.address, created.address);
  assert.equal(second.addressIndex, 1);
  assert.notEqual(second.address, first.address);
  assert.equal(last.addressIndex, 255);
  await assert.rejects(walletCommand("address", { root, wallet, passwordFile, addressIndex: "256" }), /invalid addressIndex/);
});

test("wallet creation requires a local password source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-password-test-"));
  await assert.rejects(walletCommand("create", { root, wallet: join(directory, "wallet") }), /PASSWORD_REQUIRED/);
});

test("file lock is exclusive and removed after completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-lock-test-"));
  const lock = join(directory, "wallet", ".prepare.lock");
  await withFileLock(lock, async () => {
    await assert.rejects(withFileLock(lock, async () => undefined), /another wallet operation is active/);
    assert.equal((await stat(lock)).mode & 0o777, 0o600);
  });
  await assert.rejects(stat(lock), error => error.code === "ENOENT");
});

test("file lock records owner metadata for stale-lock diagnosis", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-lock-owner-test-"));
  const lock = join(directory, "wallet", ".prepare.lock");
  await withFileLock(lock, async () => {
    const owner = JSON.parse(await readFile(lock, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.startedAt, "string");
    assert.equal(typeof owner.command, "string");
    await assert.rejects(withFileLock(lock, async () => undefined), /pid=.*alive=true/);
  });
});

test("private writes reject an existing public parent directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-public-parent-test-"));
  await chmod(directory, 0o755);
  await assert.rejects(writePrivate(join(directory, "bearer.json"), "secret"), /mode 0700/);
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
});

test("prepare refuses to overwrite any existing packet before RPC or proving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-packet-test-"));
  const wallet = join(directory, "wallet");
  const packet = join(directory, "packet.json");
  await writeFile(packet, "unknown", { mode: 0o600 });
  await assert.rejects(prepareCommand("merge", {
    root, wallet, out: packet, config: join(directory, "missing-config.json"), passwordFile: join(directory, "missing-password"), asset: "0",
  }), /refusing to overwrite/);
  assert.equal(await readFile(packet, "utf8"), "unknown");
});

test("prepare refuses to overwrite an existing intent sidecar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-intent-test-"));
  const packet = join(directory, "packet.json");
  await writeFile(`${packet}.intent.json`, "unknown", { mode: 0o600 });
  await assert.rejects(prepareCommand("merge", {
    root, wallet: join(directory, "missing-wallet"), out: packet, config: join(directory, "missing-config.json"),
    passwordFile: join(directory, "missing-password"), asset: "0",
  }), /intent sidecar already exists/);
  assert.equal(await readFile(`${packet}.intent.json`, "utf8"), "unknown");
});

test("sweep input is rejected before wallet, RPC, or proving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "404-sweep-test-"));
  const fillsFile = join(directory, "fills.json");
  const base = {
    root, wallet: join(directory, "missing-wallet"), out: join(directory, "packet.json"),
    config: join(directory, "missing-config.json"), passwordFile: join(directory, "missing-password"),
    fillsFile, minBought: "1", protocolFee: "0",
  };
  await writeFile(fillsFile, JSON.stringify([{ orderId: "7", pay: "10" }, { orderId: "7", pay: "20" }]));
  await assert.rejects(prepareCommand("sweep", base), /duplicate orderId/);
  await writeFile(fillsFile, JSON.stringify([{ orderId: "7", pay: "10", extra: "no" }]));
  await assert.rejects(prepareCommand("sweep", base), /invalid fill at index 0/);
});

test("history pagination is rejected before wallet or RPC access", async () => {
  await assert.rejects(readCommand("history", {
    root, wallet: "/missing-wallet", config: "/missing-config", offset: "0", limit: "0",
  }), /limit must be positive/);
});

test("balance excludes reserved and time-locked notes from available and two-input max", async () => {
  const note = (asset, value, lockUntil, nf) => ({ nf, note: { asset, value, lockUntil } });
  const snapshot = {
    head: { timestamp: 100n },
    unspent: [
      note(0, 10n, 0n, 1n),
      note(0, 140n, 0n, 2n),
      note(0, 30n, 101n, 3n),
      note(0, 20n, 101n, 4n),
      note(1, 8n, 0n, 5n),
      note(1, 7n, 0n, 6n),
      note(1, 6n, 0n, 7n),
    ],
  };
  const sdk = await loadSdk(root);
  const result = balanceTotals(snapshot, sdk, new Set([2n, 4n]));

  assert.deepEqual(result.token, {
    total: "200", available: "10", max: "10", notes: 4, availableNotes: 1,
    reserved: "160", reservedNotes: 2, locked: "30", lockedNotes: 1,
  });
  assert.deepEqual(result.native, {
    total: "21", available: "21", max: "15", notes: 3, availableNotes: 3,
    reserved: "0", reservedNotes: 0, locked: "0", lockedNotes: 0,
  });
});

test("void intent is reviewable and other actions require an exported packet", () => {
  assert.deepEqual(parseIntent({ kind: "void", asset: "0", originalId: "original", voids: "original" }), {
    kind: "void", asset: "0", originalId: "original", voids: "original",
  });
  assert.throws(() => parseIntent({ kind: "void", asset: "0", originalId: "original", voids: "original", extra: "no" }), /invalid packet intent/);
  assert.throws(() => preparationResult("send", {}, undefined), /did not export/);
});

test("legacy withdrawal intents are presented with the Protocol 404 name", () => {
  assert.deepEqual(parseIntent({ kind: "unshield", asset: "0", amount: "10", recipient: "0xabc" }), {
    kind: "withdraw", asset: "0", amount: "10", recipient: "0xabc",
  });
});

test("deposit intent records the asset and note amount", () => {
  assert.deepEqual(parseIntent({ kind: "deposit", asset: "1", amount: "250000" }), {
    kind: "deposit", asset: "1", amount: "250000",
  });
});

function fakeVoidSession(records, onVoid = async () => {}) {
  let values = records.map(record => ({ ...record }));
  let syncs = 0; let voids = 0;
  return {
    pendingTransactions: () => values.map(record => ({ ...record })),
    sync: async () => { syncs += 1; },
    void: async id => { voids += 1; await onVoid(id, value => { values = value; }); },
    journal: {
      get: id => {
        const record = values.find(value => value.id === id);
        if (!record) throw new Error("unknown transaction journal entry");
        return { ...record };
      },
      mark: async (id, status) => { values = values.map(record => record.id === id ? { ...record, status } : record); },
    },
    counts: () => ({ syncs, voids }),
  };
}

test("repeating void re-exports the exact saved cancellation without SDK wallet submission", async () => {
  const record = { id: "cancel", createdAt: 2, status: "exported", authorization: "saved-auth",
    intent: { kind: "void", originalId: "original", asset: "0", voids: "original" } };
  const session = fakeVoidSession([record]);
  let recovered;
  const result = await prepareVoid(session, "original", {
    exportAuthorization: async (text, value) => { recovered = { text, value }; },
    isExported: () => Boolean(recovered),
  });
  assert.equal(result, undefined);
  assert.equal(recovered.text, "saved-auth");
  assert.equal(recovered.value.id, "cancel");
  assert.deepEqual(session.counts(), { syncs: 1, voids: 0 });
});

test("an unknown cancellation stops without invoking SDK wallet submission", async () => {
  const session = fakeVoidSession([{ id: "cancel", createdAt: 2, status: "unknown",
    intent: { kind: "void", originalId: "original" } }]);
  await assert.rejects(prepareVoid(session, "original", {
    exportAuthorization: async () => assert.fail("must not export unknown cancellation"), isExported: () => false,
  }), /VOID_ALREADY_PENDING/);
  assert.deepEqual(session.counts(), { syncs: 1, voids: 0 });
});

test("a locally prepared original is truthfully discarded without an export claim", async () => {
  const original = { id: "original", createdAt: 1, status: "prepared", intent: { kind: "send" } };
  const session = fakeVoidSession([original], async (id, replace) => replace([]));
  const result = await prepareVoid(session, "original", {
    exportAuthorization: async () => assert.fail("discard must not export"), isExported: () => false,
  });
  assert.deepEqual(result, {
    packet: null, originalJournalId: "original", operation: "void", exported: false, status: "discarded",
  });
  assert.deepEqual(session.counts(), { syncs: 0, voids: 1 });
});

test("void requires its original journal id before wallet or RPC access", async () => {
  await assert.rejects(prepareCommand("void", {
    root, wallet: "/missing-wallet", out: "/missing-packet", config: "/missing-config",
  }), /missing journalId/);
});
