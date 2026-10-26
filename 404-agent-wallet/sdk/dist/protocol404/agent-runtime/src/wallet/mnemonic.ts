import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/** Converts a 32-byte seed into the original 24-word English backup.*/
export function createMnemonicBackup(seed: Uint8Array): string {
  if (seed.length !== 32) throw new RangeError("seed must be 32 bytes");
  return entropyToMnemonic(seed, wordlist);
}

/** Normalizes and restores an original 24-word English backup.*/
export function restoreMnemonicBackup(backup: string): Uint8Array {
  const normalized = backup.trim().toLowerCase().split(/\s+/).join(" ");
  const seed = mnemonicToEntropy(normalized, wordlist);
  if (seed.length !== 32) throw new Error("the backup must be 24 words");
  return seed;
}
