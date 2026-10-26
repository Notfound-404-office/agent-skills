import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { BN254_FIELD_MODULUS, bytesToBigInt, concatBytes, utf8 } from './bytes.ts';
import { poseidonHash2 } from './poseidon.ts';

export type RistrettoPoint = InstanceType<typeof ristretto255.Point>;

export type KeyMaterial = Readonly<{
  seed: Uint8Array;
  sk: bigint;
  nk: bigint;
  ivk: bigint;
  ovk: Uint8Array;
  spendPub: bigint;
  nkc: bigint;
}>;

/** @orig index-CVtw0LZh.js:18525 FS Derive a protocol domain as keccak256("pm:<name>:v1") mod Fr. */
function protocolDomain(name: string): bigint {
  return bytesToBigInt(keccak_256(utf8(`pm:${name}:v1`))) % BN254_FIELD_MODULUS;
}

/** @orig index-CVtw0LZh.js:18528 IS PROTOCOL: immutable circuit hash domains. */
export const DOMAINS = Object.freeze({
  SPEND: protocolDomain('SPEND'),
  NKC: protocolDomain('NKC'),
  OWNER: protocolDomain('OWNER'),
  INNER: protocolDomain('INNER'),
  NOTE: protocolDomain('NOTE'),
  LOC: protocolDomain('LOC'),
  NF: protocolDomain('NF'),
  TAG: protocolDomain('TAG'),
  TAG_DUMMY: protocolDomain('TAG_DUMMY'),
});

/** @orig index-CVtw0LZh.js:18530 LS HKDF-SHA256 used throughout the note protocol. */
export function deriveBytes(input: Uint8Array, info: string | Uint8Array, length: number): Uint8Array {
  return hkdf(sha256, input, undefined, typeof info === 'string' ? utf8(info) : info, length);
}

function reduceWide(bytes: Uint8Array, modulus: bigint): bigint {
  if (bytes.length !== 64) throw new RangeError('wide reduction needs 64 bytes');
  const scalar = bytesToBigInt(bytes) % modulus;
  if (scalar === 0n) throw new RangeError('zero scalar');
  return scalar;
}

/** @orig index-CVtw0LZh.js:18535 zS Deterministically derive all private scanning and spending keys. */
export function deriveKeys(seed: Uint8Array): KeyMaterial {
  if (seed.length !== 32) throw new RangeError('seed must be 32 bytes');
  const scalarOrder = ristretto255.Point.Fn.ORDER;
  const sk = reduceWide(deriveBytes(seed, 'pm/sk', 64), BN254_FIELD_MODULUS);
  const nk = reduceWide(deriveBytes(seed, 'pm/nk', 64), BN254_FIELD_MODULUS);
  return Object.freeze({
    seed,
    sk,
    nk,
    ivk: reduceWide(deriveBytes(seed, 'pm/ivk', 64), scalarOrder),
    ovk: deriveBytes(seed, 'pm/ovk', 32),
    spendPub: poseidonHash2(DOMAINS.SPEND, sk),
    nkc: poseidonHash2(DOMAINS.NKC, nk),
  });
}

/** @orig index-CVtw0LZh.js:18829 pC PROTOCOL: Ristretto hash-to-group domain. */
const DIVERSIFIER_DST = utf8('pm/gd/v1');

/** @orig index-CVtw0LZh.js:18832 hC Map an 11-byte diversifier to a Ristretto point. */
export function diversifierPoint(diversifier: Uint8Array): RistrettoPoint {
  if (diversifier.length !== 11) throw new RangeError('diversifier must be 11 bytes');
  // noble-curves 1.9 returns the Ristretto wrapper at runtime, although its generic declaration is wider.
  return ristretto255_hasher.hashToCurve(diversifier, { DST: DIVERSIFIER_DST }) as RistrettoPoint;
}

/** @orig index-CVtw0LZh.js:19429 Nw Recipient ECDH note-encryption key. */
export function incomingEncryptionKey(sharedPoint: RistrettoPoint, ephemeralKey: Uint8Array, context: Uint8Array): Uint8Array {
  return deriveBytes(concatBytes(sharedPoint.toBytes(), ephemeralKey), context, 32);
}
