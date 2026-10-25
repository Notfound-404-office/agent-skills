import { decryptSeed, encryptSeed, parseWalletFile, type EncryptedWalletFile } from "./encryption.ts";
import { LEGACY_WALLET_STORAGE_KEY } from "../compatibility.ts";

export const DEFAULT_WALLET_STORAGE_KEY = LEGACY_WALLET_STORAGE_KEY;

/** Minimal persistence boundary: storage contains encrypted JSON and never the plaintext seed. */
export class EncryptedWalletStore {
  #unlockedSeed: Uint8Array | null = null;
  readonly #storage: Storage;
  readonly #key: string;

  public constructor(storage: Storage, key = DEFAULT_WALLET_STORAGE_KEY) {
    this.#storage = storage;
    this.#key = key;
  }

  public exists(): boolean {
    return this.#storage.getItem(this.#key) !== null;
  }

  public async save(seed: Uint8Array, password: string): Promise<EncryptedWalletFile> {
    const wallet = await encryptSeed(seed, password);
    this.#storage.setItem(this.#key, JSON.stringify(wallet));
    this.#unlockedSeed = seed.slice();
    return wallet;
  }

  public import(serializedWallet: string): EncryptedWalletFile {
    const wallet = parseWalletFile(JSON.parse(serializedWallet) as unknown);
    this.#storage.setItem(this.#key, JSON.stringify(wallet));
    this.lock();
    return wallet;
  }

  public export(): string {
    const serialized = this.#storage.getItem(this.#key);
    if (serialized === null) throw new Error("wallet not found");
    parseWalletFile(JSON.parse(serialized) as unknown);
    return serialized;
  }

  public async unlock(password: string): Promise<Uint8Array> {
    const serialized = this.#storage.getItem(this.#key);
    if (serialized === null) throw new Error("wallet not found");
    const seed = await decryptSeed(parseWalletFile(JSON.parse(serialized) as unknown), password);
    this.#unlockedSeed = seed;
    return seed.slice();
  }

  public getSeed(): Uint8Array | null {
    return this.#unlockedSeed?.slice() ?? null;
  }

  public lock(): void {
    this.#unlockedSeed?.fill(0);
    this.#unlockedSeed = null;
  }

  public remove(): void {
    this.lock();
    this.#storage.removeItem(this.#key);
  }
}
