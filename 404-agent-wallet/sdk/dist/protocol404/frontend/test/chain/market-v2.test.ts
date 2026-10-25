import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from '../../src/chain/client.ts';
import {
  NOTE_SCALE, fillAmounts, marketFeeOf, maxPayWithMarketFee, readMarketStats, readMarketTrades, sweepAmounts,
  type MarketOrder,
} from '../../src/chain/trading.ts';

const listing = (id: bigint, nativePerThousand: bigint, remaining = 1_000n * NOTE_SCALE): MarketOrder => ({
  id, sellAsset: 0, open: true, releases: 0,
  maker: '0x0000000000000000000000000000000000000001',
  sellAmount: 1_000n * NOTE_SCALE, buyAmount: nativePerThousand, remaining, proceeds: 0n,
});

test('2% market fee quotes buyer payment and maker proceeds in both order directions', () => {
  const sell = listing(1n, 100n * NOTE_SCALE);
  const buy = { ...sell, sellAsset: 1 as const, sellAmount: 100n * NOTE_SCALE,
    buyAmount: 1_000n * NOTE_SCALE, remaining: 100n * NOTE_SCALE };
  for (const order of [sell, buy]) {
    const quote = fillAmounts(order, 1_000n * NOTE_SCALE, 0n, 0n, undefined, 200n)!;
    assert.equal(quote.protocolFee, quote.pay * 2n / 100n);
    assert.equal(quote.totalPay, quote.pay * 102n / 100n);
    assert.equal(quote.pay - quote.protocolFee, quote.pay * 98n / 100n);
  }
});

test('MarketV2 fee rounding and inverse budget remain exact for integer edge cases', () => {
  assert.equal(marketFeeOf(9n, 1_000n), 0n);
  assert.equal(marketFeeOf(10n, 1_000n), 1n);
  assert.equal(maxPayWithMarketFee(10n, 1_000n), 9n);
  assert.equal(maxPayWithMarketFee(11n, 1_000n), 10n);

  const quote = fillAmounts(listing(1n, NOTE_SCALE), 1_000n * NOTE_SCALE, 0n, 3n, 110_000_002n, 1_000n)!;
  assert.ok(quote.pay + quote.protocolFee + 3n <= 110_000_002n);
  assert.ok(quote.pay + 1n + marketFeeOf(quote.pay + 1n, 1_000n) + 3n > 110_000_002n);
  assert.equal(quote.deducted, true);
});

test('sweep chooses cheapest listings, caps 20 fills, and aggregates each rounded fee', () => {
  const orders = Array.from({ length: 22 }, (_, index) => listing(BigInt(index), BigInt(22 - index) * 1_000_000n, 100n * NOTE_SCALE));
  const quote = sweepAmounts(orders, 2_100n * NOTE_SCALE, 0n, 333n)!;
  assert.equal(quote.fills.length, 20);
  assert.equal(quote.fills[0]?.orderId, 21n);
  assert.equal(quote.fills[19]?.orderId, 2n);
  assert.equal(quote.protocolFee, quote.fills.reduce((sum, fill) => sum + marketFeeOf(fill.pay, 333n), 0n));
  assert.equal(quote.totalPay, quote.pay + quote.protocolFee);
});

test('sweep compares listing prices by exact cross multiplication before truncation', () => {
  const cheaper = { ...listing(1n, 1n), sellAmount: 100_000_000_000n, remaining: 100_000_000_000n };
  const dearer = { ...listing(0n, 2n), sellAmount: 199_999_999_999n, remaining: 199_999_999_999n };
  const quote = sweepAmounts([dearer, cheaper], cheaper.remaining, 0n, 0n)!;
  assert.equal(quote.fills[0]?.orderId, cheaper.id);
});

test('public trade and stats readers validate the relayer schema without wallet fields', async () => {
  const config = { indexerUrls: ['https://relayer.example'] };
  const connection = { config } as unknown as PoolConnection;
  const responses = [
    { total: 1, trades: [{ orderId: '7', sellAsset: 0, paid: '2000000', bought: '100000000000', fee: '200000', time: 10, tx: `0x${'11'.repeat(32)}`, block: '12', logIndex: 3 }], indexedTo: '12', syncing: false, volume24h: { token: '100000000000', native: '2000000' } },
    { now: 10, last: '2000000', open24h: null, high24h: '2000000', low24h: '2000000', trades24h: 1, volume24h: { token: '100000000000', native: '2000000' }, range: '1d', bucket: 1800, points: [{ t: 0, close: null, token: '0', native: '0', trades: 0 }] },
  ];
  const fetcher = async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  const trades = await readMarketTrades(connection, fetcher as typeof fetch);
  const stats = await readMarketStats(connection, '1d', fetcher as typeof fetch);
  assert.equal(trades.trades[0]?.price, 2_000_000n);
  assert.equal(stats.open24h, null);
  assert.equal(stats.points[0]?.close, null);
  assert.deepEqual(Object.keys(trades.trades[0]!).sort(), ['block', 'bought', 'fee', 'logIndex', 'orderId', 'paid', 'price', 'sellAsset', 'time', 'tx']);
});
