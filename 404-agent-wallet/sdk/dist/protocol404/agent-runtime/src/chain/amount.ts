import { nativeUnitWei } from '../config/index.ts';

/** @orig index-CVtw0LZh.js:29112 hk Preserve grouped thousands; never silently round money. */
export function parseNoteAmount(value: string): bigint {
  const normalized = value.trim();
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(normalized)) throw new Error('Invalid amount: use "." for decimals; commas may only separate thousands');
  const [whole, fraction = ''] = normalized.replaceAll(',', '').split('.');
  if (fraction.length > 8) throw new Error('At most 8 decimal places');
  const amount = BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  if (amount <= 0n || amount >= 1n << 64n) throw new Error('Amount must be positive and fit a 64-bit note');
  return amount;
}

/** The circuit consumes at most two notes; never offer a Max that needs a third. */
export function maxNoteSpend(values: readonly bigint[], fee = 0n): bigint {
  const total = [...values].sort((left, right) => left > right ? -1 : left < right ? 1 : 0).slice(0, 2).reduce((sum, value) => sum + value, 0n);
  const available = total > fee ? total - fee : 0n;
  return available < (1n << 64n) ? available : (1n << 64n) - 1n;
}

/** A top-up creates a new input: it must cover the mint with just one existing note. */
export function mintFunding(values: readonly bigint[], totalWei: bigint, fee: bigint): { required: bigint; minimumTopup: bigint } {
  if (totalWei <= 0n) throw new Error('the mint total must be positive');
  if (totalWei % nativeUnitWei !== 0n) throw new Error('the mint price is not a whole number of native units');
  const required = totalWei / nativeUnitWei + fee;
  if (required <= 0n || required >= 1n << 64n) throw new Error('mint funding must fit a 64-bit note');
  if (maxNoteSpend(values) >= required) return { required, minimumTopup: 0n };
  const largest = values.reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  return { required, minimumTopup: required - largest };
}
