const WINDOW = 5_000n;
const RETRYABLE_RANGE = /range|too many (?:logs|results)|response size/i;
const INTENT_FIELDS = new Set([
  "kind", "asset", "amount", "recipient", "count", "orderId", "nonce",
  "originalId", "voids", "buyAmount", "sellAmount", "pay", "minBought",
  "orderIds", "pays", "keyIndex", "action",
]);

const lower = value => typeof value === "string" ? value.toLowerCase() : value;
const decimal = value => BigInt(value).toString();
const assetName = value => Number(value) === 1 ? "native" : "token";

function safeIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return {};
  const result = {};
  for (const [key, value] of Object.entries(intent)) {
    if (!INTENT_FIELDS.has(key)) continue;
    if (typeof value === "string") result[key] = key === "kind" && value === "unshield" ? "withdraw" : value;
    else if ((key === "orderIds" || key === "pays") && Array.isArray(value) && value.every(item => typeof item === "string")) result[key] = [...value];
  }
  return result;
}

function safeRecord(record) {
  const result = {
    id: String(record.id),
    createdAt: Number(record.createdAt),
    status: String(record.status),
    intent: safeIntent(record.intent),
  };
  if (typeof record.txHash === "string") result.txHash = record.txHash;
  return result;
}

async function scan(client, address, events, fromBlock, toBlock) {
  const logs = [];
  let span = WINDOW;
  for (let from = fromBlock; from <= toBlock;) {
    const to = from + span - 1n < toBlock ? from + span - 1n : toBlock;
    try {
      logs.push(...await client.getLogs({ address, events, fromBlock: from, toBlock: to, strict: true }));
      from = to + 1n;
    } catch (error) {
      if (span > 1n && RETRYABLE_RANGE.test(String(error))) { span /= 2n; continue; }
      throw error;
    }
  }
  return logs.sort((a, b) => a.blockNumber === b.blockNumber
    ? Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0)
    : a.blockNumber < b.blockNumber ? -1 : 1);
}

function orderEvent(log, marketAddress) {
  const args = log.args ?? {};
  const base = { type: log.eventName, orderId: decimal(args.orderId), marketAddress };
  if (log.eventName === "OrderPlaced") return { ...base, maker: args.maker, sellAsset: Number(args.sellAsset), sellAmount: decimal(args.sellAmount), buyAmount: decimal(args.buyAmount) };
  if (log.eventName === "OrderFilled") return { ...base, paid: decimal(args.paid), bought: decimal(args.bought), fee: args.fee === undefined ? null : decimal(args.fee), shielded: Boolean(args.shielded) };
  if (log.eventName === "OrderReleased") return { ...base, action: Number(args.action), amount: decimal(args.amount), fee: decimal(args.fee) };
  return base;
}

function transaction(map, log) {
  const key = lower(log.transactionHash);
  if (!key || typeof log.blockNumber !== "bigint") throw new Error("history log is missing transaction or block metadata");
  let entry = map.get(key);
  if (!entry) {
    entry = {
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      status: "observed",
      operation: "unknown",
      noteFlow: {
        description: "Owned-note flow; received/spent values can include private change and are not guessed recipient transfers.",
        token: { received: 0n, spent: 0n, net: 0n },
        native: { received: 0n, spent: 0n, net: 0n },
      },
      orderEvents: [],
      local: [],
    };
    map.set(key, entry);
  } else if (entry.blockNumber !== log.blockNumber) {
    throw new Error("same transaction hash appeared in multiple blocks");
  }
  return entry;
}

function addFlow(entry, asset, side, value) {
  const row = entry.noteFlow[assetName(asset)];
  row[side] += value;
  row.net = row.received - row.spent;
}

function page(entries, offset, limit) {
  const start = offset === undefined ? 0 : Number(offset);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("history offset must be a non-negative integer");
  const count = limit === undefined ? undefined : Number(limit);
  if (count !== undefined && (!Number.isSafeInteger(count) || count <= 0)) throw new Error("history limit must be a positive integer");
  const result = count === undefined ? entries.slice(start) : entries.slice(start, start + count);
  const end = start + result.length;
  return { result, nextOffset: end < entries.length ? end : null };
}

/** Build complete wallet-scoped history against the already verified sync snapshot. */
export async function buildHistory({ connection, snapshot, records = [], poolEvents, marketEvents, orderMaker }, { offset, limit } = {}) {
  if (!connection?.client || !connection?.config || !snapshot?.head || !Array.isArray(snapshot.owned)) throw new Error("invalid history context");
  const { client, config } = connection;
  const fromBlock = BigInt(config.deployBlock);
  const toBlock = BigInt(snapshot.head.number);
  if (fromBlock > toBlock) throw new Error("deployment block is ahead of the verified snapshot");

  const [poolLogs, marketLogs] = await Promise.all([
    scan(client, config.contracts.pool, poolEvents, fromBlock, toBlock),
    scan(client, config.contracts.market, marketEvents, fromBlock, toBlock),
  ]);
  const byLeaf = new Map(snapshot.owned.map(note => [BigInt(note.leafIndex).toString(), note]));
  const byNullifier = new Map(snapshot.owned.map(note => [BigInt(note.nf).toString(), note]));
  if (byLeaf.size !== snapshot.owned.length || byNullifier.size !== snapshot.owned.length) throw new Error("verified snapshot contains duplicate owned notes");
  const noteLogs = new Map();
  const nullifierLogs = new Map();
  for (const log of poolLogs) {
    if (log.eventName === "NoteAdded") {
      const key = decimal(log.args?.leafIndex);
      if (byLeaf.has(key)) noteLogs.set(key, [...(noteLogs.get(key) ?? []), log]);
    } else if (log.eventName === "Nullified") {
      const key = decimal(log.args?.nullifier);
      if (byNullifier.has(key)) nullifierLogs.set(key, [...(nullifierLogs.get(key) ?? []), log]);
    }
  }
  for (const owned of snapshot.owned) {
    const leaf = BigInt(owned.leafIndex).toString();
    const additions = noteLogs.get(leaf) ?? [];
    if (additions.length !== 1) throw new Error("owned note events do not match the verified snapshot");
    if (owned.cm !== undefined && decimal(additions[0].args?.commitment) !== BigInt(owned.cm).toString()) {
      throw new Error("owned note commitment does not match the verified snapshot");
    }
    const nf = BigInt(owned.nf).toString();
    const nullifications = nullifierLogs.get(nf) ?? [];
    const isSpent = snapshot.spent instanceof Set && snapshot.spent.has(BigInt(owned.nf));
    if ((isSpent && nullifications.length !== 1) || (!isSpent && nullifications.length !== 0)) {
      throw new Error("owned nullifier events do not match the verified snapshot");
    }
  }
  const transactions = new Map();

  for (const log of poolLogs) {
    if (log.eventName === "NoteAdded") {
      const owned = byLeaf.get(decimal(log.args?.leafIndex));
      if (owned) addFlow(transaction(transactions, log), owned.note.asset, "received", BigInt(owned.note.value));
    } else if (log.eventName === "Nullified") {
      const owned = byNullifier.get(decimal(log.args?.nullifier));
      if (owned) addFlow(transaction(transactions, log), owned.note.asset, "spent", BigInt(owned.note.value));
    }
  }

  const orderLogs = marketLogs.filter(log => ["OrderPlaced", "OrderFilled", "OrderReleased"].includes(log.eventName));
  const placed = orderLogs.filter(log => log.eventName === "OrderPlaced");
  const makers = new Set(placed.map(log => lower(log.args?.maker)).filter(Boolean));
  const ownedMakers = new Set();
  if (makers.size) for (let index = 0; index < 10_000; index++) {
    const maker = lower(await orderMaker(index));
    if (makers.has(maker)) ownedMakers.add(maker);
  }
  const ownedOrders = new Set(placed.filter(log => ownedMakers.has(lower(log.args?.maker))).map(log => decimal(log.args.orderId)));

  const safeRecords = records.map(safeRecord);
  const localHashes = new Set(safeRecords.map(record => lower(record.txHash)).filter(Boolean));
  const walletHashes = new Set([...transactions.keys(), ...localHashes]);
  for (const log of orderLogs) {
    const orderId = decimal(log.args?.orderId);
    if (!ownedOrders.has(orderId) && !walletHashes.has(lower(log.transactionHash))) continue;
    transaction(transactions, log).orderEvents.push(orderEvent(log, config.contracts.market));
  }

  const unmergedLocal = [];
  for (const record of safeRecords) {
    const entry = record.txHash && transactions.get(lower(record.txHash));
    if (entry) entry.local.push(record);
    else unmergedLocal.push(record);
  }

  const blockNumbers = [...new Set([...transactions.values()].map(entry => entry.blockNumber.toString()))];
  const blocks = new Map();
  for (let start = 0; start < blockNumbers.length; start += 25) {
    await Promise.all(blockNumbers.slice(start, start + 25).map(async number => {
      const block = await client.getBlock({ blockNumber: BigInt(number) });
      blocks.set(number, block);
    }));
  }
  const pinned = await client.getBlock({ blockNumber: toBlock });
  if (lower(pinned.hash) !== lower(snapshot.head.hash)) throw new Error("chain reorganized while reading history; retry");

  const all = [...transactions.values()].map(entry => {
    const localKinds = [...new Set(entry.local.map(record => record.intent.kind).filter(Boolean))];
    const marketTypes = [...new Set(entry.orderEvents.map(event => event.type))];
    const operation = localKinds.length === 1 ? localKinds[0] : localKinds.length ? "multiple" : marketTypes.length === 1 ? marketTypes[0] : marketTypes.length ? "market" : "unknown";
    const flow = Object.fromEntries(Object.entries(entry.noteFlow).map(([key, value]) => key === "description" ? [key, value] : [key, {
      received: value.received.toString(), spent: value.spent.toString(), net: value.net.toString(),
    }]));
    return {
      txHash: entry.txHash,
      blockNumber: entry.blockNumber.toString(),
      timestamp: BigInt(blocks.get(entry.blockNumber.toString()).timestamp).toString(),
      status: entry.status,
      operation,
      noteFlow: flow,
      ...(marketTypes.length ? { marketTypes, marketAddress: config.contracts.market, orderEvents: entry.orderEvents } : {}),
      ...(entry.local.length ? { local: entry.local } : {}),
    };
  }).sort((a, b) => BigInt(a.blockNumber) === BigInt(b.blockNumber)
    ? b.txHash.localeCompare(a.txHash)
    : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? -1 : 1);
  const paged = page(all, offset, limit);
  return {
    transactions: paged.result,
    local: unmergedLocal,
    total: all.length,
    nextOffset: paged.nextOffset,
    coverage: {
      complete: true,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      headHash: snapshot.head.hash,
      orderMakerRange: { from: 0, to: 9_999 },
      note: "Chain history is wallet-scoped. Order recovery checks deterministic maker indexes 0..9999; note flows may include change.",
    },
  };
}
