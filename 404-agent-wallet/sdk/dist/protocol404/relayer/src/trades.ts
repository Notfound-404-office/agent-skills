import type { Hex } from "viem";
import { HttpError } from "./service.js";

export type MarketEvent =
  | { kind: "placed"; orderId: bigint; sellAsset: number; block: bigint; logIndex: number }
  | { kind: "filled"; orderId: bigint; paid: bigint; bought: bigint; fee: bigint; block: bigint; logIndex: number; tx: Hex };

export interface TradeSource {
  blockNumber(): Promise<bigint>;
  marketEvents(fromBlock: bigint, toBlock: bigint): Promise<MarketEvent[]>;
  blockTimestamp(block: bigint): Promise<number>;
  orderSellAsset(orderId: bigint, block: bigint): Promise<number>;
}

export type PublicTrade = {
  orderId: string; sellAsset: number; paid: string; bought: string; fee: string;
  time: number; tx: Hex; block: string; logIndex: number;
};

type Placed = { sellAsset: number; block: bigint };
const REORG_BLOCKS = 12n;
const SCAN_BLOCKS = 5_000n;

function normalizedVolume(trade: PublicTrade): { token: bigint; native: bigint } {
  return trade.sellAsset === 0
    ? { token: BigInt(trade.bought), native: BigInt(trade.paid) }
    : { token: BigInt(trade.paid), native: BigInt(trade.bought) };
}

/** In-memory incremental event index with a bounded reorg rollback window. */
export class TradeIndexer {
  private readonly trades: PublicTrade[] = [];
  private readonly placed = new Map<string, Placed>();
  private readonly timestamps = new Map<string, number>();
  private indexedTo?: bigint;
  private syncing?: Promise<void>;
  private readonly source: TradeSource;
  private readonly startBlock?: bigint;

  constructor(source: TradeSource, startBlock?: bigint) { this.source = source; this.startBlock = startBlock; }

  async list(offset: number, limit: number) {
    await this.sync();
    const ordered = [...this.trades].sort((a, b) => b.block === a.block ? b.logIndex - a.logIndex : BigInt(b.block) > BigInt(a.block) ? 1 : -1);
    const recent = ordered.filter(trade => trade.time >= Math.floor(Date.now() / 1000) - 86_400);
    const volume24h = recent.reduce((sum, trade) => {
      const value = normalizedVolume(trade);
      return { token: sum.token + value.token, native: sum.native + value.native };
    }, { token: 0n, native: 0n });
    return { total: ordered.length, trades: ordered.slice(offset, offset + limit), indexedTo: String(this.indexedTo), syncing: false, volume24h: { token: String(volume24h.token), native: String(volume24h.native) } };
  }

  async stats(range: "1d" | "7d" | "30d" | "all") {
    await this.sync();
    const now = Math.floor(Date.now() / 1000);
    const settings = range === "1d" ? [86_400, 1_800] : range === "7d" ? [604_800, 14_400] : range === "30d" ? [2_592_000, 86_400] : [0, 86_400];
    const earliest = this.trades.reduce((value, trade) => Math.min(value, trade.time), now);
    const from = settings[0] === 0 ? earliest : now - settings[0];
    const bucket = settings[1];
    const selected = this.trades.filter(trade => trade.time >= from).sort((a, b) => a.time - b.time || Number(BigInt(a.block) - BigInt(b.block)) || a.logIndex - b.logIndex);
    const price = (trade: PublicTrade): bigint | null => {
      const volume = normalizedVolume(trade);
      return volume.token === 0n ? null : volume.native * 1000n * 100_000_000n / volume.token;
    };
    const recent24h = this.trades.filter(trade => trade.time >= now - 86_400).sort((a, b) => a.time - b.time || a.logIndex - b.logIndex);
    const prices24h = recent24h.map(price).filter((value): value is bigint => value !== null);
    const lastTrade = [...this.trades].sort((a, b) => b.time - a.time || b.logIndex - a.logIndex)[0];
    const last = lastTrade ? price(lastTrade) : null;
    const volume24h = recent24h.reduce((sum, trade) => {
      const value = normalizedVolume(trade);
      return { token: sum.token + value.token, native: sum.native + value.native };
    }, { token: 0n, native: 0n });
    const end = Math.floor(now / bucket) * bucket;
    const start = settings[0] === 0 ? Math.floor(from / bucket) * bucket : end - settings[0] + bucket;
    const points = [];
    for (let t = start; t <= end; t += bucket) {
      const rows = selected.filter(trade => trade.time >= t && trade.time < t + bucket);
      const amounts = rows.reduce((sum, trade) => { const value = normalizedVolume(trade); return { token: sum.token + value.token, native: sum.native + value.native }; }, { token: 0n, native: 0n });
      const close = rows.length ? price(rows[rows.length - 1]) : null;
      points.push({ t, close: close === null ? null : String(close), token: String(amounts.token), native: String(amounts.native), trades: rows.length });
    }
    return {
      now, last: last === null ? null : String(last),
      open24h: prices24h.length ? String(prices24h[0]) : null,
      high24h: prices24h.length ? String(prices24h.reduce((a, b) => a > b ? a : b)) : null,
      low24h: prices24h.length ? String(prices24h.reduce((a, b) => a < b ? a : b)) : null,
      trades24h: recent24h.length,
      volume24h: { token: String(volume24h.token), native: String(volume24h.native) }, range, bucket, points,
    };
  }

  private async sync(): Promise<void> {
    if (this.startBlock === undefined) throw new HttpError(503, "RELAYER_MARKET_BLOCK is required for trade history");
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private async runSync(): Promise<void> {
    const head = await this.source.blockNumber();
    if (head < this.startBlock!) {
      this.trades.length = 0;
      this.placed.clear();
      this.timestamps.clear();
      this.indexedTo = head;
      return;
    }
    const normalRollback = this.indexedTo === undefined ? this.startBlock! : this.indexedTo - REORG_BLOCKS + 1n > this.startBlock! ? this.indexedTo - REORG_BLOCKS + 1n : this.startBlock!;
    const headRollback = head - REORG_BLOCKS + 1n > this.startBlock! ? head - REORG_BLOCKS + 1n : this.startBlock!;
    const from = normalRollback < headRollback ? normalRollback : headRollback;
    this.trades.splice(0, this.trades.length, ...this.trades.filter(trade => BigInt(trade.block) < from));
    for (const [orderId, value] of this.placed) if (value.block >= from) this.placed.delete(orderId);
    for (const block of this.timestamps.keys()) if (BigInt(block) >= from) this.timestamps.delete(block);
    for (let cursor = from; cursor <= head; cursor += SCAN_BLOCKS) {
      const to = cursor + SCAN_BLOCKS - 1n < head ? cursor + SCAN_BLOCKS - 1n : head;
      const events = await this.source.marketEvents(cursor, to);
      events.sort((a, b) => a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);
      for (const event of events) {
        const key = String(event.orderId);
        if (event.kind === "placed") { this.placed.set(key, { sellAsset: event.sellAsset, block: event.block }); continue; }
        const known = this.placed.get(key);
        const sellAsset = known?.sellAsset ?? await this.source.orderSellAsset(event.orderId, event.block);
        if (sellAsset !== 0 && sellAsset !== 1) throw new Error(`invalid sell asset for order ${key}`);
        let time = this.timestamps.get(String(event.block));
        if (time === undefined) { time = await this.source.blockTimestamp(event.block); this.timestamps.set(String(event.block), time); }
        this.trades.push({ orderId: key, sellAsset, paid: String(event.paid), bought: String(event.bought), fee: String(event.fee), time, tx: event.tx, block: String(event.block), logIndex: event.logIndex });
      }
    }
    this.indexedTo = head;
  }
}
