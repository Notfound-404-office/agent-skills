import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNoteAmount } from '../../src/chain/amount.ts';

test('human note amounts are exact, never rounded or expressed as exponents', () => {
  assert.equal(parseNoteAmount('0.00000001'), 1n);
  assert.equal(parseNoteAmount('1000.5'), 100050000000n);
  assert.equal(parseNoteAmount('1,000.5'), 100050000000n);
  for (const invalid of ['0', '-1', '1e3', '0.000000001', '184467440738', '1.234567899', '10,00']) assert.throws(() => parseNoteAmount(invalid));
});
