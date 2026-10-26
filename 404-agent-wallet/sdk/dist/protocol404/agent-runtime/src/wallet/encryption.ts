import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { LEGACY_WALLET_AAD } from "../compatibility.ts";

/** Password-hardening parameters used by the original wallet file format. */
export interface WalletScryptParameters {
  readonly name: "scrypt";
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly dkLen: 32;
}

/** Version-one encrypted wallet file, encoded entirely as JSON-safe values. */
export interface EncryptedWalletFile {
  readonly version: 1;
  readonly kdf: WalletScryptParameters;
  readonly salt: `0x${string}`;
  readonly nonce: `0x${string}`;
  readonly seed: `0x${string}`;
}

/** Password-hardening parameters for the wallet format. */
export const SCRYPT_PARAMS: WalletScryptParameters = Object.freeze({
  name: "scrypt",
  N: 2 ** 17,
  r: 8,
  p: 1,
  dkLen: 32,
});

/** PROTOCOL: authenticated-data label is part of the version-one wallet format. */
const WALLET_AAD = new TextEncoder().encode(LEGACY_WALLET_AAD);

/** Encodes bytes with the original lowercase `0x` representation. */
function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Applies viem's strict hexadecimal predicate. */
function isStrictHex(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

/** Decodes hexadecimal, including the original left-padding of odd nibbles.*/
function hexToBytes(value: `0x${string}`): Uint8Array {
  let digits = value.slice(2);
  if (digits.length % 2) digits = `0${digits}`;
  const output = new Uint8Array(digits.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(digits.slice(index * 2, 2 + index * 2), 16);
  }
  return output;
}

/** Password-hardening parameters for the wallet format. */
async function deriveWalletKey(
  password: string,
  salt: Uint8Array,
  parameters: Pick<WalletScryptParameters, "N" | "r" | "p">,
  onProgress?: (progress: number) => void,
): Promise<Uint8Array> {
  return scryptAsync(new TextEncoder().encode(password), salt, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    dkLen: 32,
    onProgress,
  });
}

/** Encrypts one 32-byte wallet seed with scrypt and ChaCha20-Poly1305.*/
export async function encryptSeed(
  seed: Uint8Array,
  password: string,
  onProgress?: (progress: number) => void,
): Promise<EncryptedWalletFile> {
  if (seed.length !== 32) throw new RangeError("seed must be 32 bytes");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveWalletKey(password, salt, SCRYPT_PARAMS, onProgress);
  const ciphertext = chacha20poly1305(key, nonce, WALLET_AAD).encrypt(seed);
  return {
    version: 1,
    kdf: { ...SCRYPT_PARAMS },
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    seed: bytesToHex(ciphertext),
  };
}

/** Decrypts a validated version-one wallet file.*/
export async function decryptSeed(
  wallet: EncryptedWalletFile,
  password: string,
  onProgress?: (progress: number) => void,
): Promise<Uint8Array> {
  const key = await deriveWalletKey(password, hexToBytes(wallet.salt), wallet.kdf, onProgress);
  try {
    return chacha20poly1305(key, hexToBytes(wallet.nonce), WALLET_AAD).decrypt(hexToBytes(wallet.seed));
  } catch {
    throw new Error("wrong password or damaged wallet file");
  }
}

/** Validates and normalizes untrusted JSON as an original wallet file.*/
export function parseWalletFile(value: unknown): EncryptedWalletFile {
  const wallet = value as Partial<EncryptedWalletFile> | null;
  const kdf = wallet?.kdf as Partial<WalletScryptParameters> | undefined;
  const numbers = [kdf?.N, kdf?.r, kdf?.p];
  const valid =
    wallet?.version === 1 &&
    kdf?.name === "scrypt" &&
    numbers.every((number) => Number.isSafeInteger(number) && (number as number) > 0) &&
    (kdf.N as number) >= 2 ** 15 &&
    (kdf.N as number) <= 2 ** 18 &&
    !((kdf.N as number) & ((kdf.N as number) - 1)) &&
    kdf.r === 8 &&
    (kdf.p as number) <= 4 &&
    isStrictHex(wallet.salt) &&
    isStrictHex(wallet.nonce) &&
    isStrictHex(wallet.seed) &&
    wallet.salt.length >= 34 &&
    wallet.salt.length <= 130 &&
    wallet.nonce.length === 26 &&
    wallet.seed.length === 98;

  if (!valid) throw new Error("not a compatible 404 wallet file");
  return {
    version: 1,
    kdf: {
      name: "scrypt",
      N: kdf.N as number,
      r: 8,
      p: kdf.p as number,
      dkLen: 32,
    },
    salt: wallet.salt as `0x${string}`,
    nonce: wallet.nonce as `0x${string}`,
    seed: wallet.seed as `0x${string}`,
  };
}
