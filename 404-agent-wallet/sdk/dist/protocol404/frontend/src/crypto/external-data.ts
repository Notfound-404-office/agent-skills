import { keccak_256 } from '@noble/hashes/sha3.js';
import { bigIntToBytes, bytesToBigInt, concatBytes } from './bytes.ts';
import { NOTE_CIPHERTEXT_LENGTH } from './cipher.ts';

export type ExternalData = Readonly<{
  recipient: Uint8Array;
  relayer: Uint8Array;
  caller: Uint8Array;
  data: Uint8Array;
  ciphertexts: readonly [Uint8Array, Uint8Array];
}>;

/** @orig index-CVtw0LZh.js:19568 Jw Hash the exact external transaction data committed by the circuit. */
export function externalDataHash(context: { chainId: bigint; pool: Uint8Array }, data: ExternalData): bigint {
  if (context.pool.length !== 20) throw new RangeError('pool must be 20 bytes');
  for (const ciphertext of data.ciphertexts) {
    if (ciphertext.length !== NOTE_CIPHERTEXT_LENGTH) throw new RangeError('ciphertext length');
  }
  for (const [label, bytes] of [['recipient', data.recipient], ['relayer', data.relayer], ['caller', data.caller]] as const) {
    if (bytes.length !== 20) throw new RangeError(`${label} must be 20 bytes`);
  }
  if (data.data.length !== 32) throw new RangeError('data must be 32 bytes');
  return bytesToBigInt(keccak_256(concatBytes(
    bigIntToBytes(context.chainId, 32), context.pool, data.recipient, data.relayer, data.caller,
    data.data, data.ciphertexts[0], data.ciphertexts[1],
  ))) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
}
