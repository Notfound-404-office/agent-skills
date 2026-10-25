import assert from 'node:assert/strict';
import test from 'node:test';
import { maxNoteSpend, mintFunding, parseNoteAmount } from '../../src/chain/amount.ts';

test('Max uses two inputs, reserves the fee, and respects 64-bit note amounts', () => {
  const values = [30n, 80n, 50n];
  assert.equal(maxNoteSpend(values), 130n);
  assert.equal(maxNoteSpend(values, 10n), 120n);
  assert.deepEqual(values, [30n, 80n, 50n]);
  assert.equal(maxNoteSpend([], 10n), 0n);
  assert.equal(maxNoteSpend([10n], 10n), 0n);
  assert.equal(maxNoteSpend([5n], 10n), 0n);
  assert.equal(maxNoteSpend([1n << 63n, 1n << 63n]), (1n << 64n) - 1n);
  assert.equal(parseNoteAmount('1,000.00000001'), 100_000_000_001n);
  assert.throws(() => parseNoteAmount('1.000000001'), /8 decimal/);
});

test('mint funding adds the smallest note that makes two inputs sufficient', () => {
  const totalWei = 1_000_000_000_000_000n;
  const fee = 10_000n;
  assert.deepEqual(mintFunding([40_000n, 40_000n, 40_000n], totalWei, fee), { required: 110_000n, minimumTopup: 70_000n });
  assert.deepEqual(mintFunding([60_000n, 50_000n], totalWei, fee), { required: 110_000n, minimumTopup: 0n });
  assert.deepEqual(mintFunding([], totalWei, fee), { required: 110_000n, minimumTopup: 110_000n });
  assert.ok(maxNoteSpend([40_000n, 30_000n]) < 110_000n);
  assert.ok(maxNoteSpend([40_000n, 70_000n]) >= 110_000n);
  assert.throws(() => mintFunding([], totalWei + 1n, fee), /whole number of native units/);
});
