import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type { PoolConnection } from '../../src/chain/client.ts';
import { readCachedMarketOrders, readFreshMarketOrders } from '../../src/chain/market-orders.ts';
import type { MarketOrder } from '../../src/chain/trading.ts';

const maker = '0x0000000000000000000000000000000000000001' as Address;
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}` as Hash;
const order = (id: bigint, values: Partial<MarketOrder> = {}): MarketOrder => ({
  id, sellAsset: 0, open: true, releases: 0, maker,
  sellAmount: 100n, buyAmount: 50n, remaining: 100n, proceeds: 0n, ...values,
});

type Fake = {
  connection: PoolConnection;
  calls: { orderIds: bigint[]; counts: number; readBlocks: bigint[]; logs: Array<{ name: string; from: bigint; to: bigint }> };
  setHead(number: bigint, blockHash?: Hash): void;
  setOrder(value: MarketOrder): void;
  addLog(name: 'OrderPlaced' | 'OrderFilled' | 'OrderReleased', block: bigint, id: bigint): void;
  failOrderOnce(id: bigint): void;
  failLogsOnce(message: string): void;
};

let marketSequence = 10;
function fake(initial: readonly MarketOrder[], version: 1 | 2 = 1, maxLogRange = 1_000_000n): Fake {
  const market = `0x${(marketSequence++).toString(16).padStart(40, '0')}` as Address;
  const orders = new Map(initial.map(value => [value.id, { ...value }]));
  const blocks = new Map<bigint, Hash>([[10n, hash(10)]]);
  const logs: Array<{ name: string; block: bigint; id: bigint }> = [];
  const calls = { orderIds: [] as bigint[], counts: 0, readBlocks: [] as bigint[], logs: [] as Array<{ name: string; from: bigint; to: bigint }> };
  const failures = new Set<bigint>();
  let logFailure: string | undefined;
  let head = 10n;
  const client = {
    async getBlock(request?: { blockNumber?: bigint }) {
      const number = request?.blockNumber ?? head;
      return { number, hash: blocks.get(number) ?? hash(Number(number)) };
    },
    async readContract(request: { functionName: string; args?: readonly bigint[]; blockNumber?: bigint }) {
      if (request.blockNumber !== head) throw new Error('contract read was not pinned to the current head');
      calls.readBlocks.push(request.blockNumber);
      if (request.functionName === 'orderCount') { calls.counts++; return BigInt(orders.size); }
      const id = request.args?.[0];
      if (id === undefined) throw new Error('missing order id');
      calls.orderIds.push(id);
      if (failures.delete(id)) throw new Error('temporary order read failure');
      const value = orders.get(id);
      if (!value) throw new Error(`unknown order ${id}`);
      const { id: _id, ...raw } = value;
      return raw;
    },
    async getLogs(request: { event: { name: string }; fromBlock: bigint; toBlock: bigint }) {
      const name = request.event.name;
      calls.logs.push({ name, from: request.fromBlock, to: request.toBlock });
      if (logFailure) { const message = logFailure; logFailure = undefined; throw new Error(message); }
      if (request.toBlock - request.fromBlock + 1n > maxLogRange) throw new Error('range too wide');
      return logs.filter(log => log.name === name && log.block >= request.fromBlock && log.block <= request.toBlock)
        .map((log, index) => ({ blockNumber: log.block, logIndex: index, args: { orderId: log.id } }));
    },
  };
  const connection = {
    client,
    config: {
      chain: { id: 56 }, marketVersion: version, deployBlock: 1n, marketBlock: 1n,
      contracts: { market },
    },
  } as unknown as PoolConnection;
  return {
    connection, calls,
    setHead(number, blockHash = hash(Number(number))) { head = number; blocks.set(number, blockHash); },
    setOrder(value) { orders.set(value.id, { ...value }); },
    addLog(name, block, id) { logs.push({ name, block, id }); },
    failOrderOnce(id) { failures.add(id); },
    failLogsOnce(message) { logFailure = message; },
  };
}

function installMemoryIndexedDb(): { restore(): void; corrupt(): void } {
  const original = globalThis.indexedDB;
  const values = new Map<IDBValidKey, unknown>();
  const database = {
    objectStoreNames: { contains: () => true }, createObjectStore() {}, close() {},
    transaction() {
      const transaction: Record<string, unknown> = {};
      transaction.objectStore = () => ({
        get(key: IDBValidKey) {
          const request: Record<string, unknown> = {};
          queueMicrotask(() => { request.result = structuredClone(values.get(key)); (request.onsuccess as (() => void) | undefined)?.(); });
          return request;
        },
        put(value: unknown, key: IDBValidKey) {
          values.set(key, structuredClone(value));
          queueMicrotask(() => (transaction.oncomplete as (() => void) | undefined)?.());
        },
      });
      return transaction;
    },
  };
  const indexedDb = {
    open() {
      const request: Record<string, unknown> = {};
      queueMicrotask(() => { request.result = database; (request.onsuccess as (() => void) | undefined)?.(); });
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDb });
  return {
    restore: () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: original }),
    corrupt() {
      for (const [key, value] of values) {
        const stored = structuredClone(value) as { orders?: Array<{ maker?: string }> };
        if (stored.orders?.[0]) stored.orders[0].maker = 'invalid';
        values.set(key, stored);
      }
    },
  };
}

test('bootstrap reads and retains complete older order history only once', async () => {
  const source = fake([
    order(0n), order(1n, { open: false, remaining: 0n, proceeds: 25n }),
    order(2n, { open: false, remaining: 0n, proceeds: 0n }),
  ]);
  const [first, concurrent] = await Promise.all([
    readCachedMarketOrders(source.connection), readCachedMarketOrders(source.connection),
  ]);
  const second = await readCachedMarketOrders(source.connection);
  assert.deepEqual(first, concurrent);
  assert.deepEqual(second.map(value => value.id), [0n, 1n, 2n]);
  assert.deepEqual(source.calls.orderIds, [0n, 1n, 2n]);
  assert.equal(source.calls.counts, 1);
  assert.equal(source.calls.logs.length, 0);
});

test('incremental polling refreshes touched IDs and no-change heads read no orders', async () => {
  const source = fake([order(0n), order(1n)], 2);
  await readCachedMarketOrders(source.connection);
  source.setOrder(order(1n, { remaining: 40n, proceeds: 30n }));
  source.addLog('OrderFilled', 11n, 1n);
  source.setHead(11n);
  const changed = await readCachedMarketOrders(source.connection);
  assert.equal(changed[1]?.remaining, 40n);
  assert.deepEqual(source.calls.orderIds, [0n, 1n, 1n]);
  assert.equal(source.calls.counts, 2);
  source.setHead(12n);
  await readCachedMarketOrders(source.connection);
  assert.deepEqual(source.calls.orderIds, [0n, 1n, 1n]);
  assert.equal(source.calls.counts, 3);
  assert.ok(source.calls.logs.some(call => call.name === 'OrderFilled'));
});

test('persisted snapshot reload avoids historical order reads', async () => {
  const database = installMemoryIndexedDb();
  try {
    const first = fake([order(0n), order(1n, { open: false, proceeds: 10n })]);
    await readCachedMarketOrders(first.connection);
    const second = fake([order(0n), order(1n, { open: false, proceeds: 10n })]);
    (second.connection.config.contracts as { market: Address }).market = first.connection.config.contracts.market;
    const loaded = await readCachedMarketOrders(second.connection);
    assert.deepEqual(loaded.map(value => value.id), [0n, 1n]);
    assert.equal(second.calls.counts, 0);
    assert.deepEqual(second.calls.orderIds, []);
    database.corrupt();
    const third = fake([order(0n), order(1n, { open: false, proceeds: 10n })]);
    (third.connection.config.contracts as { market: Address }).market = first.connection.config.contracts.market;
    await readCachedMarketOrders(third.connection);
    assert.equal(third.calls.counts, 1);
    assert.deepEqual(third.calls.orderIds, [0n, 1n]);
  } finally { database.restore(); }
});

test('file-backed snapshot reload avoids historical order reads without indexedDB', async () => {
  const values = new Map<string, unknown>();
  const store = {
    load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, value: unknown) => { values.set(key, JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item))); },
  };
  const first = fake([order(0n), order(1n, { open: false, proceeds: 10n })]);
  await readCachedMarketOrders(first.connection, store);
  const second = fake([order(0n), order(1n, { open: false, proceeds: 10n })]);
  (second.connection.config.contracts as { market: Address }).market = first.connection.config.contracts.market;
  const loaded = await readCachedMarketOrders(second.connection, store);
  assert.deepEqual(loaded.map(value => value.id), [0n, 1n]);
  assert.equal(second.calls.counts, 0);
  assert.deepEqual(second.calls.orderIds, []);
});

test('cursor hash mismatch rebuilds instead of retaining orphan orders', async () => {
  const source = fake([order(0n), order(1n)]);
  await readCachedMarketOrders(source.connection);
  source.setOrder(order(0n, { remaining: 75n }));
  source.setOrder(order(1n, { open: false, remaining: 0n }));
  source.setHead(10n, hash(999));
  const rebuilt = await readCachedMarketOrders(source.connection);
  assert.equal(rebuilt[0]?.remaining, 75n);
  assert.equal(rebuilt[1]?.open, false);
  assert.deepEqual(source.calls.orderIds, [0n, 1n, 0n, 1n]);
  assert.equal(source.calls.counts, 2);
});

test('adaptive scans retry bounded ranges and failed sync does not advance the cursor', async () => {
  const source = fake([order(0n)], 1, 2n);
  await readCachedMarketOrders(source.connection);
  source.setOrder(order(0n, { remaining: 50n }));
  source.addLog('OrderFilled', 14n, 0n);
  source.setHead(14n);
  source.failOrderOnce(0n);
  await assert.rejects(readCachedMarketOrders(source.connection), /temporary order read failure/);
  const recovered = await readCachedMarketOrders(source.connection);
  assert.equal(recovered[0]?.remaining, 50n);
  assert.ok(source.calls.logs.some(call => call.to - call.from + 1n > 2n));
  assert.ok(source.calls.logs.filter(call => call.from === 11n).length >= 6);
});

test('non-range log errors fail immediately without shrinking the scan window', async () => {
  const source = fake([order(0n)]);
  await readCachedMarketOrders(source.connection);
  source.setHead(20n);
  source.failLogsOnce('HTTP 429 network unavailable');
  await assert.rejects(readCachedMarketOrders(source.connection), /429 network unavailable/);
  assert.equal(source.calls.logs.length, 3);
});

test('fresh reads pin one head, deduplicate IDs, and leave cached synchronization pending', async () => {
  const source = fake([order(0n), order(1n)]);
  await readCachedMarketOrders(source.connection);
  source.setOrder(order(1n, { remaining: 20n }));
  source.addLog('OrderFilled', 11n, 1n);
  source.setHead(11n);
  const fresh = await readFreshMarketOrders(source.connection, [1n, 1n]);
  assert.equal(fresh[0]?.remaining, 20n);
  assert.deepEqual(source.calls.orderIds, [0n, 1n, 1n]);
  await readCachedMarketOrders(source.connection);
  assert.deepEqual(source.calls.orderIds, [0n, 1n, 1n, 1n]);
  assert.ok(source.calls.readBlocks.every(block => block === 10n || block === 11n));
});
