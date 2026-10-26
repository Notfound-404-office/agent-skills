import { type PrivateAddress } from './address.ts';
import { ristretto255 } from '@noble/curves/ed25519.js';
import { assertU64, bigIntToBytes, bytesToBigInt, concatBytes } from './bytes.ts';
import { deriveBytes, DOMAINS } from './keys.ts';
import { poseidonHash3, poseidonHash4 } from './poseidon.ts';

/** v1 supports only the deployed 404 token (0) and BNB (1). */
export type Asset = 0 | 1;
export type Note = Readonly<{
  asset: Asset;
  d: Uint8Array;
  value: bigint;
  lockUntil: bigint;
  rseed: Uint8Array;
  memo: Uint8Array;
}>;

export type NoteOptions = {
  asset?: Asset;
  lockUntil?: bigint;
  rseed?: Uint8Array;
  memo?: Uint8Array;
};

/** @orig index-CVtw0LZh.js:18875 bC Valid asset identifiers. */
export function assertAsset(asset: number): Asset {
  if (asset !== 0 && asset !== 1) throw new RangeError(`unknown asset ${asset}`);
  return asset;
}

function secureRandom(length: number): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('crypto.getRandomValues must be defined');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** @orig index-CVtw0LZh.js:18885 TC Construct the canonical fixed-width note object. */
export function createNote(to: PrivateAddress, value: bigint, options: NoteOptions = {}): Note {
  const memo = new Uint8Array(63);
  if (options.memo) {
    if (options.memo.length > 63) throw new RangeError('memo too long');
    memo.set(options.memo);
  }
  const rseed = options.rseed ?? secureRandom(32);
  if (rseed.length !== 32) throw new RangeError('rseed must be 32 bytes');
  return {
    asset: assertAsset(options.asset ?? 0),
    d: to.d,
    value: assertU64(value, 'value'),
    lockUntil: assertU64(options.lockUntil ?? 0n, 'lockUntil'),
    rseed,
    memo,
  };
}

/** @orig index-CVtw0LZh.js:18903 EC Derive note commitment randomness and ephemeral scalar. */
export function deriveNoteSecrets(rseed: Uint8Array): { rcm: bigint; esk: bigint } {
  return {
    rcm: reduceWide(deriveBytes(rseed, 'pm/rcm', 64), FIELD_MODULUS),
    esk: reduceWide(deriveBytes(rseed, 'pm/esk', 64), ristretto255.Point.Fn.ORDER),
  };
}

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ASSET_SHIFT = 1n << 64n;
function reduceWide(bytes: Uint8Array, modulus: bigint): bigint {
  if (bytes.length !== 64) throw new RangeError('wide reduction needs 64 bytes');
  const scalar = bytesToBigInt(bytes) % modulus;
  if (scalar === 0n) throw new RangeError('zero scalar');
  return scalar;
}

/** @orig index-CVtw0LZh.js:18909 DC Hash the note's owner, lock and randomness. */
export const noteInner = (owner: bigint, lockUntil: bigint, rcm: bigint): bigint =>
  poseidonHash4(DOMAINS.INNER, owner, lockUntil, rcm);

/** @orig index-CVtw0LZh.js:18910 OC Compute the public note commitment. */
export const noteCommitment = (note: Note, owner: bigint, rcm: bigint): bigint =>
  poseidonHash3(DOMAINS.NOTE, note.value + BigInt(note.asset) * ASSET_SHIFT, noteInner(owner, note.lockUntil, rcm));

/** @orig index-CVtw0LZh.js:18911 kC Commit a note to its Merkle location. */
export const noteLocation = (commitment: bigint, leafIndex: bigint): bigint => poseidonHash3(DOMAINS.LOC, commitment, leafIndex);

/** @orig index-CVtw0LZh.js:18912 AC Derive a note nullifier. */
export const noteNullifier = (nk: bigint, location: bigint): bigint => poseidonHash3(DOMAINS.NF, nk, location);

/** Serialize a note into its version 3, 127-byte AEAD plaintext. */
export function encodeNotePlaintext(note: Note): Uint8Array {
  return concatBytes(
    Uint8Array.of(3), bigIntToBytes(BigInt(assertAsset(note.asset)), 4), note.d, bigIntToBytes(note.value, 8),
    bigIntToBytes(note.lockUntil, 8), note.rseed, note.memo,
  );
}

/** Decode a canonical version 3 plaintext, or an explicit legacy version 2 plaintext. */
export function decodeNotePlaintext(bytes: Uint8Array): Note {
  if (bytes.length === 127 && bytes[0] === 3) {
    return {
      asset: assertAsset(Number(bytesToBigInt(bytes.slice(1, 5)))),
      d: bytes.slice(5, 16),
      value: bytesToBigInt(bytes.slice(16, 24)),
      lockUntil: bytesToBigInt(bytes.slice(24, 32)),
      rseed: bytes.slice(32, 64),
      memo: bytes.slice(64, 127),
    };
  }
  if (bytes.length !== 124 || bytes[0] !== 2) throw new Error('bad note plaintext');
  const legacyAsset = bytes[1]!;
  if (legacyAsset !== 0 && legacyAsset !== 1) throw new Error('bad note plaintext');
  return {
    asset: legacyAsset,
    d: bytes.slice(2, 13),
    value: bytesToBigInt(bytes.slice(13, 21)),
    lockUntil: bytesToBigInt(bytes.slice(21, 29)),
    rseed: bytes.slice(29, 61),
    memo: bytes.slice(61, 124),
  };
}
