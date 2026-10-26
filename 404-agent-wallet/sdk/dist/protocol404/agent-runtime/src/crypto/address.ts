import { bech32m } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ristretto255 } from '@noble/curves/ed25519.js';
import { privateAddressPrefix } from '../config/index.ts';
import { assertField, bigIntToBytes, bytesToBigInt, concatBytes, equalBytes, utf8 } from './bytes.ts';
import { DOMAINS, diversifierPoint, type KeyMaterial, type RistrettoPoint } from './keys.ts';
import { poseidonHash4 } from './poseidon.ts';

export type PrivateAddress = Readonly<{
  d: Uint8Array;
  pkd: RistrettoPoint;
  owner: bigint;
}>;

/** @orig index-CVtw0LZh.js:18839 gC Bind public keys and diversifier into the circuit owner value. */
export function addressOwner(spendPub: bigint, nkc: bigint, diversifier: Uint8Array): bigint {
  if (diversifier.length !== 11) throw new RangeError('diversifier must be 11 bytes');
  return poseidonHash4(DOMAINS.OWNER, spendPub, nkc, bytesToBigInt(diversifier));
}

function secureRandom(length: number): Uint8Array {
  if (length > 65536 || typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues must be defined');
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** @orig index-CVtw0LZh.js:18844 _C Derive a diversified payment address from incoming-viewing keys. */
export function deriveAddress(keys: KeyMaterial, diversifier = secureRandom(11)): PrivateAddress {
  return {
    d: diversifier,
    pkd: diversifierPoint(diversifier).multiply(keys.ivk),
    owner: addressOwner(keys.spendPub, keys.nkc, diversifier),
  };
}

/** @orig index-CVtw0LZh.js:18830 mC Four-byte application checksum over the 76-byte address body. */
function addressChecksum(body: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(utf8('pm/address/v1'), body)).slice(0, 4);
}

/** @orig index-CVtw0LZh.js:18852 vC Encode version, diversifier, point, owner and checksum as bech32m. */
export function encodePrivateAddress(address: PrivateAddress): string {
  const body = concatBytes(Uint8Array.of(1), address.d, address.pkd.toBytes(), bigIntToBytes(address.owner, 32));
  return bech32m.encode(privateAddressPrefix, bech32m.toWords(concatBytes(body, addressChecksum(body))), false);
}

/** @orig index-CVtw0LZh.js:18857 yC Parse and validate a protocol private address. */
export function decodePrivateAddress(encoded: string): PrivateAddress {
  const { prefix, words } = bech32m.decode(encoded.trim() as `${string}1${string}`, false);
  if (prefix !== privateAddressPrefix) throw new Error('wrong address prefix');
  const bytes = bech32m.fromWords(words);
  if (bytes.length !== 80 || bytes[0] !== 1) throw new Error('bad address encoding');
  const body = bytes.slice(0, 76);
  if (!equalBytes(addressChecksum(body), bytes.slice(76))) throw new Error('address checksum mismatch');
  const pkd = ristretto255.Point.fromBytes(body.slice(12, 44));
  if (pkd.equals(ristretto255.Point.ZERO)) throw new Error('bad address key');
  return { d: body.slice(1, 12), pkd, owner: assertField(bytesToBigInt(body.slice(44)), 'owner') };
}
