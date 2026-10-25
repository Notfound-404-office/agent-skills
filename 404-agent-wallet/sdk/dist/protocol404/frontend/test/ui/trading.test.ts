import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTE_SCALE, fillAmounts, liquidityNativeValue, orderAmounts, swapQuote, type MarketOrder } from '../../src/chain/trading.ts';
import { assertReviewedMarketOrders, marketChartGeometry, marketChangeBps, marketTransactionUrl, maxFillSize, maxOrderSize, maxTradingSpend, orderProceedsCoverRelease } from '../../src/ui/trading.ts';

test('a changed order or release nonce requires another transaction review', () => {
  const reviewed: MarketOrder = { id: 1n, sellAsset: 0, open: true, releases: 0,
    maker: '0x0000000000000000000000000000000000000001',
    sellAmount: 100n, buyAmount: 50n, remaining: 100n, proceeds: 0n };
  assert.doesNotThrow(() => assertReviewedMarketOrders([reviewed], [{ ...reviewed }]));
  for (const change of [{ remaining: 80n }, { proceeds: 10n }, { releases: 1 }, { open: false }, { buyAmount: 60n }]) {
    assert.throws(() => assertReviewedMarketOrders([reviewed], [{ ...reviewed, ...change }]), /review the transaction again/);
  }
  assert.throws(() => assertReviewedMarketOrders([reviewed], []), /review the transaction again/);
});

test('swapQuote preserves the original 30 bps constant-product formula', () => {
  assert.equal(swapQuote({
    reserveToken: 100_000n * NOTE_SCALE,
    reserveNative: 100n * NOTE_SCALE,
  }, 0, 1_000n * NOTE_SCALE), 98_715_803n);
  assert.equal(swapQuote({ reserveToken: 0n, reserveNative: NOTE_SCALE }, 0, NOTE_SCALE), 0n);
});

test('liquidity native note units convert to wei exactly once', () => {
  assert.equal(liquidityNativeValue(NOTE_SCALE), 1_000_000_000_000_000_000n);
});

test('orderAmounts uses native per 1,000 tokens and rounds down exactly', () => {
  assert.deepEqual(orderAmounts('sell', 1_000_000n, 2_500n * NOTE_SCALE), {
    sellAsset: 0,
    sellAmount: 250_000_000_000n,
    buyAmount: 2_500_000n,
    token: 250_000_000_000n,
    native: 2_500_000n,
    deducted: false,
  });
});

test('fillAmounts rounds up only when doing so consumes release-fee dust exactly', () => {
  const order: MarketOrder = {
    id: 4n, sellAsset: 0, open: true, releases: 0,
    maker: '0x0000000000000000000000000000000000000001',
    sellAmount: 1_000n * NOTE_SCALE,
    buyAmount: NOTE_SCALE,
    remaining: 100n * NOTE_SCALE,
    proceeds: 0n,
  };
  assert.deepEqual(fillAmounts(order, 95n * NOTE_SCALE, 10n * NOTE_SCALE), {
    pay: 10_000_000n,
    bought: 10_000_000_000n,
    protocolFee: 0n,
    totalPay: 10_000_000n,
    leavesDust: false,
    deducted: false,
  });
});

test('market stats change and SVG geometry preserve integer prices and empty buckets', () => {
  assert.equal(marketChangeBps({ open24h: 100n, last: 125n }), 2_500n);
  assert.equal(marketChangeBps({ open24h: 0n, last: 125n }), null);
  const chart = marketChartGeometry([
    { t: 1, close: null, token: 0n, native: 0n, trades: 0 },
    { t: 2, close: 100n, token: 4n, native: 2n, trades: 1 },
    { t: 3, close: 200n, token: 8n, native: 4n, trades: 1 },
  ], 100, 100);
  assert.match(chart.line, /^M50\.00,70\.00 L100\.00,0\.00$/);
  assert.equal(chart.bars[2]?.height, 30);
  assert.equal(marketTransactionUrl(56, '0x1234'), 'https://bscscan.com/tx/0x1234');
  assert.equal(marketTransactionUrl(97, '0x1234'), 'https://testnet.bscscan.com/tx/0x1234');
  assert.equal(marketTransactionUrl(11155111, '0x1234'), 'https://sepolia.etherscan.io/tx/0x1234');
});

test('trading Max uses two notes and reserves or separately covers the native fee', () => {
  assert.equal(maxTradingSpend(1, [80n, 40n, 30n], [], 10n), 110n);
  assert.equal(maxTradingSpend(0, [70n, 50n, 30n], [8n, 3n], 10n), 120n);
  assert.equal(maxTradingSpend(0, [70n, 50n], [5n, 4n], 10n), 0n);
});

test('buy-order Max converts the affordable native input to token size and caps the contract buy limit', () => {
  assert.equal(maxOrderSize('buy', 2n * NOTE_SCALE, 0n, 3n * NOTE_SCALE), 1_500n * NOTE_SCALE);
  assert.equal(maxOrderSize('buy', 1n, 0n, 1n << 64n), (1n << 63n) - 1n);
});

test('order proceeds must still cover the release fee after the maker protocol fee', () => {
  assert.equal(orderProceedsCoverRelease(10_001n, 0n, 10_000n), true);
  assert.equal(orderProceedsCoverRelease(10_001n, 1_000n, 10_000n), false);
  assert.equal(orderProceedsCoverRelease(11_112n, 1_000n, 10_000n), true);
});

test('fill Max stays within budget instead of rounding a near-full fill over it', () => {
  const listing: MarketOrder = {
    id: 5n, sellAsset: 0, open: true, releases: 0,
    maker: '0x0000000000000000000000000000000000000001',
    sellAmount: 1_000n * NOTE_SCALE, buyAmount: NOTE_SCALE,
    remaining: 100n * NOTE_SCALE, proceeds: 0n,
  };
  const listingBudget = NOTE_SCALE / 10n - 1n;
  const listingMax = maxFillSize(listing, 10n * NOTE_SCALE, listingBudget);
  const listingResult = fillAmounts(listing, listingMax, 10n * NOTE_SCALE)!;
  assert.ok(listingResult.pay <= listingBudget && !listingResult.leavesDust);
  assert.equal(maxFillSize(listing, 10n * NOTE_SCALE, listingBudget, listingBudget), 0n);

  const offer: MarketOrder = { ...listing, id: 6n, sellAsset: 1, sellAmount: NOTE_SCALE, buyAmount: 1_000n * NOTE_SCALE, remaining: NOTE_SCALE / 10n };
  const offerBudget = 95n * NOTE_SCALE;
  const offerMax = maxFillSize(offer, NOTE_SCALE / 100n, offerBudget);
  const offerResult = fillAmounts(offer, offerMax, NOTE_SCALE / 100n)!;
  assert.ok(offerResult.pay <= offerBudget && offerResult.bought <= offer.remaining && !offerResult.leavesDust);
});
