import { parseAbi, type Address, type Hash } from 'viem';
import { rawAbis } from '../abi/index.ts';
import { nativeUnitWei } from '../config/index.ts';
import type { PoolConnection } from './client.ts';
import { readCachedMarketOrders } from './market-orders.ts';

export { readFreshMarketOrders } from './market-orders.ts';

export type Asset = 0 | 1;
/** Retained as a UI compatibility shape; no Swap contract is configured or called. */
export type SwapState = { reserveToken: bigint; reserveNative: bigint; owner: Address };
export type MarketOrder = {
  id: bigint;
  sellAsset: Asset;
  open: boolean;
  releases: number;
  maker: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  remaining: bigint;
  proceeds: bigint;
};

export type OrderAmounts = {
  sellAsset: Asset;
  sellAmount: bigint;
  buyAmount: bigint;
  token: bigint;
  native: bigint;
  deducted: boolean;
};

export type FillAmounts = {
  pay: bigint;
  bought: bigint;
  protocolFee: bigint;
  totalPay: bigint;
  leavesDust: boolean;
  deducted: boolean;
};

export type SweepFill = { orderId: bigint; pay: bigint; bought: bigint; protocolFee: bigint };
export type SweepQuote = {
  fills: readonly SweepFill[];
  pay: bigint;
  protocolFee: bigint;
  totalPay: bigint;
  bought: bigint;
};

export type MarketRange = '1d' | '7d' | '30d' | 'all';
export type MarketTrade = {
  orderId: bigint;
  sellAsset: Asset;
  paid: bigint;
  bought: bigint;
  fee: bigint;
  price: bigint;
  time: number;
  tx: Hash;
  block: bigint;
  logIndex: number;
};
export type MarketTradePage = {
  total: number;
  trades: readonly MarketTrade[];
  indexedTo: bigint;
  syncing: boolean;
  volume24h: { token: bigint; native: bigint };
};
export type MarketStatsPoint = { t: number; close: bigint | null; token: bigint; native: bigint; trades: number };
export type MarketStats = {
  now: number;
  last: bigint | null;
  open24h: bigint | null;
  high24h: bigint | null;
  low24h: bigint | null;
  trades24h: number;
  volume24h: { token: bigint; native: bigint };
  range: MarketRange;
  bucket: number;
  points: readonly MarketStatsPoint[];
};

export const NOTE_SCALE = 100_000_000n;
export const ORDER_PRICE_SCALE = 1_000n * NOTE_SCALE;
export const SWAP_FEE_BPS = 30n;
export const liquidityNativeValue = (nativeNoteUnits: bigint): bigint => nativeNoteUnits * nativeUnitWei;

/** Kept for callers that render the disabled legacy widget; it never submits a transaction. */
export function swapQuote(state: Pick<SwapState, 'reserveToken' | 'reserveNative'>, assetIn: Asset, amountIn: bigint): bigint {
  const [reserveIn, reserveOut] = assetIn === 0 ? [state.reserveToken, state.reserveNative] : [state.reserveNative, state.reserveToken];
  if (reserveIn === 0n || reserveOut === 0n || amountIn <= 0n) return 0n;
  const amountWithFee = amountIn * (10_000n - SWAP_FEE_BPS);
  return amountWithFee * reserveOut / (reserveIn * 10_000n + amountWithFee);
}
export const oppositeAsset = (asset: Asset): Asset => asset === 0 ? 1 : 0;
export const isListing = (order: MarketOrder): boolean => order.sellAsset === 0;
export const orderPrice = (order: MarketOrder): bigint => isListing(order)
  ? order.buyAmount * ORDER_PRICE_SCALE / order.sellAmount
  : order.sellAmount * ORDER_PRICE_SCALE / order.buyAmount;
export const orderSxRemaining = (order: MarketOrder): bigint => isListing(order)
  ? order.remaining
  : order.remaining * order.buyAmount / order.sellAmount;
export const orderNativeRemaining = (order: MarketOrder): bigint => isListing(order)
  ? order.remaining * order.buyAmount / order.sellAmount
  : order.remaining;

function deductFeeAtLimit(amount: bigint, fee: bigint, spendable?: bigint): { amount: bigint; deducted: boolean } {
  return fee > 0n && spendable !== undefined && amount + fee > spendable && amount <= spendable && amount > fee
    ? { amount: amount - fee, deducted: true }
    : { amount, deducted: false };
}

/** MarketV2 charges the payment asset, rounding down exactly like Solidity. */
export function marketFeeOf(pay: bigint, feeBps: bigint): bigint {
  if (pay < 0n || feeBps < 0n || feeBps > 10_000n) throw new RangeError('Invalid market fee');
  return pay * feeBps / 10_000n;
}

/** Largest principal whose principal plus protocol fee fits an exact integer budget. */
export function maxPayWithMarketFee(total: bigint, feeBps: bigint): bigint {
  if (total <= 0n) return 0n;
  if (feeBps < 0n || feeBps > 10_000n) throw new RangeError('Invalid market fee');
  let pay = total * 10_000n / (10_000n + feeBps);
  while (pay + marketFeeOf(pay, feeBps) > total) pay -= 1n;
  while (pay + 1n + marketFeeOf(pay + 1n, feeBps) <= total) pay += 1n;
  return pay;
}

/** @orig index-CVtw0LZh.js:30090 UA + :30142 KA */
export function orderAmounts(side: 'buy' | 'sell', price: bigint, sizeSx: bigint, fee = 0n, spendable?: bigint): OrderAmounts | null {
  if (price <= 0n || sizeSx <= 0n) return null;
  if (side === 'sell') {
    const adjusted = deductFeeAtLimit(sizeSx, fee, spendable);
    const native = adjusted.amount * price / ORDER_PRICE_SCALE;
    return native === 0n ? null : {
      sellAsset: 0, sellAmount: adjusted.amount, buyAmount: native,
      token: adjusted.amount, native, deducted: adjusted.deducted,
    };
  }
  const adjusted = deductFeeAtLimit(sizeSx * price / ORDER_PRICE_SCALE, fee, spendable);
  const token = adjusted.amount * ORDER_PRICE_SCALE / price;
  return adjusted.amount === 0n || token === 0n ? null : {
    sellAsset: 1, sellAmount: adjusted.amount, buyAmount: token,
    token, native: adjusted.amount, deducted: adjusted.deducted,
  };
}

/** @orig index-CVtw0LZh.js:30208 aj. The near-complete branch rounds up only when it closes the order exactly. */
export function fillAmounts(
  order: MarketOrder,
  requestedSx: bigint,
  releaseFee: bigint,
  paymentFee = 0n,
  spendable?: bigint,
  protocolFeeBps = 0n,
): FillAmounts | null {
  if (requestedSx <= 0n || order.sellAmount <= 0n || order.buyAmount <= 0n) return null;
  let pay = isListing(order) ? requestedSx * order.buyAmount / order.sellAmount : requestedSx;
  let bought = pay * order.sellAmount / order.buyAmount;
  const remainder = order.remaining - bought;
  if (remainder > 0n && remainder <= releaseFee) {
    const roundedPay = (order.remaining * order.buyAmount + order.sellAmount - 1n) / order.sellAmount;
    if (roundedPay * order.sellAmount / order.buyAmount === order.remaining) [pay, bought] = [roundedPay, order.remaining];
  }
  let deducted = false;
  if (protocolFeeBps === 0n) {
    const adjusted = deductFeeAtLimit(pay, paymentFee, spendable);
    if (adjusted.deducted) {
      pay = adjusted.amount;
      bought = pay * order.sellAmount / order.buyAmount;
      deducted = true;
    }
  } else if (spendable !== undefined && pay + marketFeeOf(pay, protocolFeeBps) + paymentFee > spendable) {
    const available = spendable > paymentFee ? spendable - paymentFee : 0n;
    const adjustedPay = maxPayWithMarketFee(available, protocolFeeBps);
    deducted = adjustedPay < pay;
    pay = adjustedPay;
    bought = pay * order.sellAmount / order.buyAmount;
  }
  const left = order.remaining - bought;
  const protocolFee = marketFeeOf(pay, protocolFeeBps);
  return pay > 0n && bought > 0n
    ? { pay, bought, protocolFee, totalPay: pay + protocolFee, leavesDust: left > 0n && left <= releaseFee, deducted }
    : null;
}

/** Select up to 20 cheapest open listings and quote their exact per-fill MarketV2 fees. */
export function sweepAmounts(
  source: readonly MarketOrder[],
  requestedSx: bigint,
  releaseFee: bigint,
  feeBps: bigint,
  limit = 20,
): SweepQuote | null {
  if (requestedSx <= 0n || limit < 1 || limit > 20) return null;
  const listings = source
    .filter(order => order.open && isListing(order) && order.remaining > 0n)
    .slice()
    .sort((left, right) => {
      const leftPrice = left.buyAmount * right.sellAmount;
      const rightPrice = right.buyAmount * left.sellAmount;
      return leftPrice < rightPrice ? -1 : leftPrice > rightPrice ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  const fills: SweepFill[] = [];
  let bought = 0n; let pay = 0n; let protocolFee = 0n;
  for (const order of listings) {
    if (fills.length >= limit || bought >= requestedSx) break;
    const wanted = requestedSx - bought;
    const amount = wanted < order.remaining ? wanted : order.remaining;
    let quote = fillAmounts(order, amount, releaseFee, 0n, undefined, feeBps);
    if (quote?.leavesDust) {
      const safeAmount = order.remaining > releaseFee + 1n ? order.remaining - releaseFee - 1n : 0n;
      quote = safeAmount > 0n ? fillAmounts(order, safeAmount < amount ? safeAmount : amount, releaseFee, 0n, undefined, feeBps) : null;
    }
    if (!quote || quote.bought > order.remaining || quote.leavesDust) continue;
    fills.push({ orderId: order.id, pay: quote.pay, bought: quote.bought, protocolFee: quote.protocolFee });
    bought += quote.bought; pay += quote.pay; protocolFee += quote.protocolFee;
  }
  return fills.length ? { fills, pay, protocolFee, totalPay: pay + protocolFee, bought } : null;
}

const marketV2ReadAbi = parseAbi(['function feeBps() view returns (uint16)']);

export async function readMarketFeeBps(connection: PoolConnection): Promise<bigint> {
  if (connection.config.marketVersion !== 2) return 0n;
  const feeBps = BigInt(await connection.client.readContract({
    address: connection.config.contracts.market,
    abi: marketV2ReadAbi,
    functionName: 'feeBps',
  }));
  if (feeBps < 0n || feeBps > 1_000n) throw new Error('Unsupported market fee');
  return feeBps;
}

function integer(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${label}`);
  return BigInt(value);
}

function safeNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}

async function marketJson(connection: PoolConnection, path: string, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  for (const base of connection.config.indexerUrls) {
    try {
      const response = await fetcher(`${base.replace(/\/+$/, '')}${path}`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid JSON');
      return body as Record<string, unknown>;
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(connection.config.indexerUrls.length ? `Market data unavailable: ${failures.join('; ')}` : 'Market data unavailable: no read-only indexer configured');
}

/** Read public fills only. The response intentionally has no maker or taker wallet field. */
export async function readMarketTrades(connection: PoolConnection, fetcher: typeof fetch = fetch): Promise<MarketTradePage> {
  const body = await marketJson(connection, '/trades?offset=0&limit=50', fetcher);
  if (!Array.isArray(body.trades) || typeof body.syncing !== 'boolean') throw new Error('Market data unavailable: invalid trades');
  const trades = body.trades.map((raw, index): MarketTrade => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid trade ${index}`);
    const row = raw as Record<string, unknown>;
    const sellAsset = safeNumber(row.sellAsset, 'sellAsset');
    if (sellAsset !== 0 && sellAsset !== 1) throw new Error('Invalid sellAsset');
    const paid = integer(row.paid, 'paid'); const bought = integer(row.bought, 'bought');
    if (paid <= 0n || bought <= 0n) throw new Error('Invalid trade amount');
    if (typeof row.tx !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(row.tx)) throw new Error('Invalid trade tx');
    return {
      orderId: integer(row.orderId, 'orderId'), sellAsset: sellAsset as Asset, paid, bought,
      fee: integer(row.fee, 'fee'), price: sellAsset === 0 ? paid * ORDER_PRICE_SCALE / bought : bought * ORDER_PRICE_SCALE / paid,
      time: safeNumber(row.time, 'time'), tx: row.tx as Hash, block: integer(row.block, 'block'), logIndex: safeNumber(row.logIndex, 'logIndex'),
    };
  });
  const volume = body.volume24h;
  if (!volume || typeof volume !== 'object' || Array.isArray(volume)) throw new Error('Invalid trade volume');
  return {
    total: safeNumber(body.total, 'total'), trades, indexedTo: integer(body.indexedTo, 'indexedTo'), syncing: body.syncing,
    volume24h: { token: integer((volume as Record<string, unknown>).token, 'token volume'), native: integer((volume as Record<string, unknown>).native, 'native volume') },
  };
}

export async function readMarketStats(connection: PoolConnection, range: MarketRange, fetcher: typeof fetch = fetch): Promise<MarketStats> {
  const body = await marketJson(connection, `/trades/stats?range=${range}`, fetcher);
  if (!Array.isArray(body.points) || body.range !== range) throw new Error('Market data unavailable: invalid stats');
  const nullableInteger = (value: unknown, label: string): bigint | null => value === null ? null : integer(value, label);
  const volume = body.volume24h;
  if (!volume || typeof volume !== 'object' || Array.isArray(volume)) throw new Error('Invalid stats volume');
  return {
    now: safeNumber(body.now, 'now'), last: nullableInteger(body.last, 'last'), open24h: nullableInteger(body.open24h, 'open24h'),
    high24h: nullableInteger(body.high24h, 'high24h'), low24h: nullableInteger(body.low24h, 'low24h'), trades24h: safeNumber(body.trades24h, 'trades24h'),
    volume24h: { token: integer((volume as Record<string, unknown>).token, 'token volume'), native: integer((volume as Record<string, unknown>).native, 'native volume') },
    range, bucket: safeNumber(body.bucket, 'bucket'),
    points: body.points.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid stats point ${index}`);
      const point = raw as Record<string, unknown>;
      return { t: safeNumber(point.t, 'point time'), close: nullableInteger(point.close, 'point close'), token: integer(point.token, 'point token'), native: integer(point.native, 'point native'), trades: safeNumber(point.trades, 'point trades') };
    }),
  };
}

export async function readSwapState(_connection: PoolConnection): Promise<SwapState> {
  throw new Error('Swap is not available in this release');
}

export async function addSwapLiquidity(
  _connection: PoolConnection, _payer: unknown, _amounts: { token: bigint; native: bigint },
  _progress: (message: string) => void, _assertCurrent?: () => void,
): Promise<Hash> {
  throw new Error('Swap liquidity is not available in this release');
}

export async function removeSwapLiquidity(
  _connection: PoolConnection, _payer: unknown, _amounts: { token: bigint; native: bigint },
  _progress: (message: string) => void, _assertCurrent?: () => void,
): Promise<Hash> {
  throw new Error('Swap liquidity is not available in this release');
}

/** Keep public orders on chain; refresh the browser snapshot through incremental events. */
export async function readMarketOrders(connection: PoolConnection): Promise<MarketOrder[]> {
  return readCachedMarketOrders(connection);
}
