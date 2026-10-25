import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ristretto255 } from '@noble/curves/ed25519.js';
import { type PrivateAddress, addressOwner } from './address.ts';
import { bigIntToBytes, concatBytes, equalBytes, utf8 } from './bytes.ts';
import { deriveBytes, diversifierPoint, incomingEncryptionKey, type KeyMaterial } from './keys.ts';
import { decodeNotePlaintext, deriveNoteSecrets, encodeNotePlaintext, noteCommitment, type Asset, type Note } from './note.ts';

export type PoolContext = Readonly<{ chainId: bigint; pool: Uint8Array }>;
export const NOTE_CIPHERTEXT_LENGTH = 175;
const LEGACY_NOTE_CIPHERTEXT_LENGTH = 172;
const ZERO_NONCE = new Uint8Array(12);
const OPEN_VALUE_AAD = utf8('pm/open-value/v1');

/** @orig index-CVtw0LZh.js:19425 Mw Build chain- and pool-specific encryption context. */
export function encryptionContext(label: 'pm/enc/v1' | 'pm/enc-self/v1', context: PoolContext): Uint8Array {
  if (context.pool.length !== 20) throw new RangeError('pool must be 20 bytes');
  return concatBytes(utf8(label), bigIntToBytes(context.chainId, 32), context.pool);
}

/** @orig index-CVtw0LZh.js:19430 Pw Sender-view encryption key. */
function outgoingEncryptionKey(ovk: Uint8Array, ephemeralKey: Uint8Array, context: PoolContext): Uint8Array {
  return deriveBytes(concatBytes(ovk, ephemeralKey), encryptionContext('pm/enc-self/v1', context), 32);
}

/** @orig index-CVtw0LZh.js:19425-19431 Nw Recipient-view encryption key. */
function recipientEncryptionKey(shared: InstanceType<typeof ristretto255.Point>, ephemeralKey: Uint8Array, context: PoolContext): Uint8Array {
  return incomingEncryptionKey(shared, ephemeralKey, encryptionContext('pm/enc/v1', context));
}

/** Encrypt the 127-byte note and prepend its 32-byte ephemeral public key. */
function seal(key: Uint8Array, ephemeralKey: Uint8Array, note: Note, commitment: bigint | null): Uint8Array {
  if (commitment === null && note.value !== 0n) throw new Error('an open-value note carries value 0');
  const aad = commitment === null ? OPEN_VALUE_AAD : bigIntToBytes(commitment, 32);
  return concatBytes(ephemeralKey, chacha20poly1305(key, ZERO_NONCE, aad).encrypt(encodeNotePlaintext(note)));
}

/** @orig index-CVtw0LZh.js:19442 Lw/Rw Encrypt a note for its recipient with the rseed-derived ephemeral scalar. */
export function encryptNote(note: Note, to: PrivateAddress, commitment: bigint | null, context: PoolContext): Uint8Array {
  if (!equalBytes(note.d, to.d)) throw new Error('note diversifier does not match address');
  const { esk } = deriveNoteSecrets(note.rseed);
  const ephemeralKey = diversifierPoint(note.d).multiply(esk).toBytes();
  return seal(recipientEncryptionKey(to.pkd.multiply(esk), ephemeralKey, context), ephemeralKey, note, commitment);
}

/** @orig index-CVtw0LZh.js:19451 zw Encrypt an output with the sender's outgoing viewing key. */
export function encryptOutgoingNote(note: Note, to: PrivateAddress, commitment: bigint | null, ovk: Uint8Array, context: PoolContext): Uint8Array {
  if (!equalBytes(note.d, to.d)) throw new Error('note diversifier does not match address');
  const { esk } = deriveNoteSecrets(note.rseed);
  const ephemeralKey = diversifierPoint(note.d).multiply(esk).toBytes();
  return seal(outgoingEncryptionKey(ovk, ephemeralKey, context), ephemeralKey, note, commitment);
}

function open(key: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Note | null {
  try {
    return decodeNotePlaintext(chacha20poly1305(key, ZERO_NONCE, aad).decrypt(ciphertext.slice(32)));
  } catch {
    return null;
  }
}

function validate(note: Note, ephemeralKey: Uint8Array, commitment: bigint, keys: KeyMaterial): boolean {
  try {
    const { esk, rcm } = deriveNoteSecrets(note.rseed);
    if (!equalBytes(diversifierPoint(note.d).multiply(esk).toBytes(), ephemeralKey)) return false;
    return noteCommitment(note, addressOwner(keys.spendPub, keys.nkc, note.d), rcm) === commitment;
  } catch {
    return false;
  }
}

function openAndValidate(
  key: Uint8Array, ciphertext: Uint8Array, commitment: bigint, keys: KeyMaterial,
  openValue?: Readonly<{ asset: Asset; value: bigint }>,
): Note | null {
  const ephemeralKey = ciphertext.slice(0, 32);
  const regular = open(key, ciphertext, bigIntToBytes(commitment, 32));
  if (regular) return validate(regular, ephemeralKey, commitment, keys) ? regular : null;
  if (!openValue) return null;
  const partial = open(key, ciphertext, OPEN_VALUE_AAD);
  if (!partial || partial.value !== 0n || partial.asset !== openValue.asset) return null;
  const restored = { ...partial, value: openValue.value };
  return validate(restored, ephemeralKey, commitment, keys) ? restored : null;
}

/** @orig index-CVtw0LZh.js:19490 Uw Try recipient-view decryption; malformed or unrelated ciphertext returns null. */
export function decryptIncomingNote(
  ciphertext: Uint8Array, commitment: bigint, keys: KeyMaterial, context: PoolContext,
  openValue?: Readonly<{ asset: Asset; value: bigint }>,
): Note | null {
  if (ciphertext.length !== NOTE_CIPHERTEXT_LENGTH && ciphertext.length !== LEGACY_NOTE_CIPHERTEXT_LENGTH) return null;
  const ephemeralKey = ciphertext.slice(0, 32);
  let shared;
  try {
    shared = ristretto255.Point.fromBytes(ephemeralKey).multiply(keys.ivk);
  } catch {
    return null;
  }
  return openAndValidate(recipientEncryptionKey(shared, ephemeralKey, context), ciphertext, commitment, keys, openValue);
}

/** @orig index-CVtw0LZh.js:19502 Ww Try sender-view decryption; malformed or unrelated ciphertext returns null. */
export function decryptOutgoingNote(
  ciphertext: Uint8Array, commitment: bigint, keys: KeyMaterial, context: PoolContext,
  openValue?: Readonly<{ asset: Asset; value: bigint }>,
): Note | null {
  if (ciphertext.length !== NOTE_CIPHERTEXT_LENGTH && ciphertext.length !== LEGACY_NOTE_CIPHERTEXT_LENGTH) return null;
  return openAndValidate(outgoingEncryptionKey(keys.ovk, ciphertext.slice(0, 32), context), ciphertext, commitment, keys, openValue);
}
