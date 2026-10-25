import type { AbiEvent, Address, Hash } from 'viem';
import { marketAbi } from '../abi/index.ts';
import type { PoolConnection } from './client.ts';
import type { MarketOrder } from './trading.ts';

type Snapshot = { block: bigint; hash: Hash; orders: Map<bigint, MarketOrder> };
type StoredSnapshot = { version: 1; block: bigint; hash: Hash; orders: MarketOrder[] };
type Entry = { snapshot?: Snapshot; running?: Promise<MarketOrder[]> };
const entries = new WeakMap<PoolConnection, Entry>();
const DB_NAME = 'protocol404-market-orders';
const STORE_NAME = 'snapshots';
const MAX_LOG_WINDOW = 5_000n;
const UINT32_MAX = (1n << 32n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function startBlock(connection: PoolConnection): bigint {
  const config = connection.config as PoolConnection['config'] & { marketBlock?: bigint };
  return config.marketBlock ?? config.deployBlock;
}

function cacheKey(connection: PoolConnection): string {
  return [
    'v1', connection.config.chain.id, connection.config.marketVersion,
    connection.config.contracts.market.toLowerCase(), startBlock(connection),
  ].join(':');
}

function cloneOrder(order: MarketOrder): MarketOrder { return { ...order }; }

function result(snapshot: Snapshot): MarketOrder[] {
  return [...snapshot.orders.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(cloneOrder);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadStored(connection: PoolConnection): Promise<Snapshot | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  let db: IDBDatabase | undefined;
  try {
    db = await openDatabase();
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db!.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(cacheKey(connection));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!value || typeof value !== 'object') return undefined;
    const stored = value as StoredSnapshot;
    if (stored.version !== 1 || typeof stored.block !== 'bigint' || stored.block < 0n
      || typeof stored.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(stored.hash) || !Array.isArray(stored.orders)) return undefined;
    const orders = new Map<bigint, MarketOrder>();
    for (let index = 0; index < stored.orders.length; index++) {
      const order = stored.orders[index];
      if (!order || order.id !== BigInt(index)) return undefined;
      try { orders.set(order.id, parseOrder(order.id, order)); } catch { return undefined; }
    }
    return { block: stored.block, hash: stored.hash, orders };
  } catch {
    return undefined;
  } finally { db?.close(); }
}

async function saveStored(connection: PoolConnection, snapshot: Snapshot): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  let db: IDBDatabase | undefined;
  try {
    db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction(STORE_NAME, 'readwrite', { durability: 'strict' });
      const stored: StoredSnapshot = { version: 1, block: snapshot.block, hash: snapshot.hash, orders: result(snapshot) };
      transaction.objectStore(STORE_NAME).put(stored, cacheKey(connection));
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    // Public market data remains available from RPC when browser persistence is unavailable.
  } finally { db?.close(); }
}

function eventsFor(connection: PoolConnection) {
  const abi = marketAbi(connection.config.marketVersion);
  const event = (name: 'OrderPlaced' | 'OrderFilled' | 'OrderReleased') => {
    const item = abi.find(candidate => candidate.type === 'event' && candidate.name === name);
    if (!item) throw new Error(`Market ABI lacks ${name}`);
    return item as AbiEvent;
  };
  return { placed: event('OrderPlaced'), filled: event('OrderFilled'), released: event('OrderReleased') };
}

function collectIds(target: Set<bigint>, logs: readonly unknown[]): void {
  for (const raw of logs) {
    const id = (raw as { args?: { orderId?: unknown } }).args?.orderId;
    if (typeof id !== 'bigint') throw new Error('Invalid market event log');
    target.add(id);
  }
}

async function scanTouchedIds(connection: PoolConnection, fromBlock: bigint, toBlock: bigint): Promise<Set<bigint>> {
  const touched = new Set<bigint>();
  if (fromBlock > toBlock) return touched;
  const selected = eventsFor(connection);
  let from = fromBlock;
  let window = MAX_LOG_WINDOW;
  while (from <= toBlock) {
    const to = from + window - 1n < toBlock ? from + window - 1n : toBlock;
    try {
      const [placed, filled, released] = await Promise.all([
        connection.client.getLogs({ address: connection.config.contracts.market, event: selected.placed, fromBlock: from, toBlock: to, strict: true }),
        connection.client.getLogs({ address: connection.config.contracts.market, event: selected.filled, fromBlock: from, toBlock: to, strict: true }),
        connection.client.getLogs({ address: connection.config.contracts.market, event: selected.released, fromBlock: from, toBlock: to, strict: true }),
      ]);
      collectIds(touched, placed); collectIds(touched, filled); collectIds(touched, released);
      from = to + 1n;
    } catch (error) {
      if (window > 1n && /range|too many (logs|results)|response size/i.test(String(error))) { window /= 2n; continue; }
      throw error;
    }
  }
  return touched;
}

function parseOrder(id: bigint, raw: unknown): MarketOrder {
  if (!raw || typeof raw !== 'object' || id < 0n || id > UINT256_MAX) throw new Error(`Invalid market order ${id}`);
  const order = raw as {
    sellAsset: number | bigint; open: boolean; releases: number | bigint; maker: Address;
    sellAmount: bigint; buyAmount: bigint; remaining: bigint; proceeds: bigint;
  };
  if (typeof order.sellAsset !== 'bigint' && (typeof order.sellAsset !== 'number' || !Number.isInteger(order.sellAsset))) {
    throw new Error(`Invalid market order ${id}`);
  }
  const sellAsset = Number(order.sellAsset);
  if (typeof order.releases !== 'bigint' && (typeof order.releases !== 'number' || !Number.isInteger(order.releases))) {
    throw new Error(`Invalid market order ${id}`);
  }
  const releases = BigInt(order.releases);
  const amounts = [order.sellAmount, order.buyAmount, order.remaining, order.proceeds];
  if ((sellAsset !== 0 && sellAsset !== 1) || typeof order.open !== 'boolean'
    || typeof order.maker !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(order.maker)
    || releases < 0n || releases > UINT32_MAX
    || amounts.some(value => typeof value !== 'bigint' || value < 0n || value > UINT64_MAX)) throw new Error(`Invalid market order ${id}`);
  return { ...order, id, sellAsset, releases: Number(releases) };
}

async function readOrdersAt(connection: PoolConnection, ids: readonly bigint[], blockNumber: bigint): Promise<MarketOrder[]> {
  const abi = marketAbi(connection.config.marketVersion);
  const orders: MarketOrder[] = [];
  for (let start = 0; start < ids.length; start += 50) {
    const pageIds = ids.slice(start, start + 50);
    const page = await Promise.all(pageIds.map(id => connection.client.readContract({
      address: connection.config.contracts.market, abi, functionName: 'orders', args: [id], blockNumber,
    })));
    page.forEach((order, index) => orders.push(parseOrder(pageIds[index]!, order)));
  }
  return orders;
}

async function verifyComplete(connection: PoolConnection, orders: Map<bigint, MarketOrder>, blockNumber: bigint): Promise<void> {
  const count = BigInt(await connection.client.readContract({
    address: connection.config.contracts.market, abi: marketAbi(connection.config.marketVersion),
    functionName: 'orderCount', blockNumber,
  }));
  if (BigInt(orders.size) !== count) throw new Error('Market order log history is incomplete');
  for (let id = 0n; id < count; id++) if (!orders.has(id)) throw new Error('Market order log history is incomplete');
}

async function head(connection: PoolConnection): Promise<{ number: bigint; hash: Hash }> {
  const block = await connection.client.getBlock();
  if (!block.hash) throw new Error('Latest block has no hash');
  return { number: block.number, hash: block.hash };
}

async function assertHead(connection: PoolConnection, expected: { number: bigint; hash: Hash }): Promise<void> {
  const block = await connection.client.getBlock({ blockNumber: expected.number });
  if (block.hash !== expected.hash) throw new Error('Chain reorganized while reading market orders; retry');
}

async function rebuild(connection: PoolConnection, latest: { number: bigint; hash: Hash }): Promise<Snapshot> {
  const count = BigInt(await connection.client.readContract({
    address: connection.config.contracts.market, abi: marketAbi(connection.config.marketVersion),
    functionName: 'orderCount', blockNumber: latest.number,
  }));
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Market order count is too large');
  const ids = Array.from({ length: Number(count) }, (_, index) => BigInt(index));
  const orders = new Map<bigint, MarketOrder>();
  for (const order of await readOrdersAt(connection, ids, latest.number)) orders.set(order.id, order);
  await assertHead(connection, latest);
  return { block: latest.number, hash: latest.hash, orders };
}

async function synchronize(connection: PoolConnection, entry: Entry): Promise<MarketOrder[]> {
  const latest = await head(connection);
  let snapshot = entry.snapshot ?? await loadStored(connection);
  let changed = false;
  if (snapshot) {
    if (snapshot.block > latest.number) snapshot = undefined;
    else {
      const cursor = await connection.client.getBlock({ blockNumber: snapshot.block });
      if (cursor.hash !== snapshot.hash) snapshot = undefined;
    }
  }
  if (!snapshot) { snapshot = await rebuild(connection, latest); changed = true; }
  else if (snapshot.block < latest.number) {
    const orders = new Map([...snapshot.orders].map(([id, order]) => [id, cloneOrder(order)]));
    const touched = await scanTouchedIds(connection, snapshot.block + 1n, latest.number);
    for (const order of await readOrdersAt(connection, [...touched], latest.number)) orders.set(order.id, order);
    await verifyComplete(connection, orders, latest.number);
    await assertHead(connection, latest);
    snapshot = { block: latest.number, hash: latest.hash, orders };
    changed = true;
  }
  entry.snapshot = snapshot;
  if (changed) await saveStored(connection, snapshot);
  return result(snapshot);
}

/** Read all historical public orders, incrementally refreshing only IDs touched by new logs. */
export function readCachedMarketOrders(connection: PoolConnection): Promise<MarketOrder[]> {
  let entry = entries.get(connection);
  if (!entry) { entry = {}; entries.set(connection, entry); }
  if (!entry.running) entry.running = synchronize(connection, entry).finally(() => { entry!.running = undefined; });
  return entry.running;
}

/** Read selected orders at one verified head without mutating the cache or its cursor. */
export async function readFreshMarketOrders(connection: PoolConnection, ids: readonly bigint[]): Promise<MarketOrder[]> {
  const latest = await head(connection);
  const unique = [...new Set(ids)];
  const orders = await readOrdersAt(connection, unique, latest.number);
  await assertHead(connection, latest);
  return orders;
}
