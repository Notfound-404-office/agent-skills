/** @orig index-CVtw0LZh.js:17975 Px Decode an unsigned big-endian integer. */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** @orig index-CVtw0LZh.js:17981 Fx Encode an unsigned integer to a fixed-width big-endian byte string. */
export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n || value >> BigInt(8 * length)) throw new RangeError('value does not fit');
  const result = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index--) {
    result[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return result;
}

/** @orig index-CVtw0LZh.js:18007 Vx Concatenate byte strings without sharing their backing buffers. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** @orig index-CVtw0LZh.js:18014 Hx Constant-time equality for equal-length byte strings. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/** @orig index-CVtw0LZh.js:17995 Lx Validate a BN254 scalar field element. */
export function assertField(value: bigint, label = 'field element'): bigint {
  if (value < 0n || value >= BN254_FIELD_MODULUS) throw new RangeError(`${label} out of range`);
  return value;
}

/** @orig index-CVtw0LZh.js:18000 Rx Validate an unsigned 64-bit value. */
export function assertU64(value: bigint, label = 'u64'): bigint {
  if (value < 0n || value > U64_MAX) throw new RangeError(`${label} out of range`);
  return value;
}

/** Validate an unsigned 32-bit integer represented as a JavaScript number. */
export function assertU32(value: number, label = 'u32'): number {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) throw new RangeError(`${label} out of range`);
  return value;
}

/** @orig index-CVtw0LZh.js:18004 zx Format a field element as a 32-byte hex value. */
export function fieldToHex(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

/** @orig index-CVtw0LZh.js:18005 Bx UTF-8 encoder used by every protocol domain string. */
export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** @orig index-CVtw0LZh.js:17971 jx BN254 scalar field modulus. */
export const BN254_FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** @orig index-CVtw0LZh.js:17973 Nx Largest accepted u64. */
export const U64_MAX = (1n << 64n) - 1n;

/** Largest accepted u32. */
export const U32_MAX = 0xffff_ffff;
