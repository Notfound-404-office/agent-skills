import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { concatBytes, deriveBytes, utf8 } from '../crypto/index.ts';

export const LIGHT_CHECKPOINT_VERSION = 1 as const;

export type LightCheckpointScope = Readonly<{
  chainId: number;
  pool: `0x${string}`;
  seed: Uint8Array;
}>;

export type StoredLightNote = Readonly<{
  leafIndex: number;
  cm: string;
  nf: string;
  publicValue: boolean;
  asset: number;
  d: Hex;
  value: string;
  lockUntil: string;
  rseed: Hex;
  memo: Hex;
}>;

export type LightCheckpoint = Readonly<{
  version: typeof LIGHT_CHECKPOINT_VERSION;
  anchor: Readonly<{ blockNumber: string; blockHash: Hex; timestamp: string }>;
  cursor: string;
  fromBlock: string;
  owned: readonly StoredLightNote[];
}>;

type EncryptedRecord = Readonly<{ version: 1; nonce: Hex; ciphertext: Hex }>;

export interface LightCheckpointStore {
  load(scope: LightCheckpointScope): Promise<LightCheckpoint | null>;
  save(scope: LightCheckpointScope, checkpoint: LightCheckpoint): Promise<void>;
  delete(scope: LightCheckpointScope): Promise<void>;
}

function binding(scope: LightCheckpointScope): Uint8Array {
  if (!Number.isSafeInteger(scope.chainId) || scope.chainId < 0) throw new RangeError('chain id out of range');
  const pool = hexToBytes(scope.pool);
  if (pool.length !== 20) throw new RangeError('pool must be 20 bytes');
  return concatBytes(utf8(`pm/light-checkpoint/v${LIGHT_CHECKPOINT_VERSION}`), utf8(String(scope.chainId)), pool);
}

function material(scope: LightCheckpointScope): { key: Uint8Array; aad: Uint8Array; id: string } {
  if (scope.seed.length !== 32) throw new RangeError('seed must be 32 bytes');
  const aad = binding(scope);
  const key = deriveBytes(scope.seed, concatBytes(utf8('pm/light-store/key/v1'), aad), 32);
  const id = bytesToHex(deriveBytes(scope.seed, concatBytes(utf8('pm/light-store/id/v1'), aad), 24));
  return { key, aad, id };
}

function randomNonce(): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('crypto.getRandomValues must be defined');
  return globalThis.crypto.getRandomValues(new Uint8Array(24));
}

function seal(scope: LightCheckpointScope, checkpoint: LightCheckpoint): EncryptedRecord {
  const { key, aad } = material(scope);
  const nonce = randomNonce();
  const plaintext = utf8(JSON.stringify(checkpoint));
  return { version: 1, nonce: bytesToHex(nonce), ciphertext: bytesToHex(xchacha20poly1305(key, nonce, aad).encrypt(plaintext)) };
}

function open(scope: LightCheckpointScope, record: EncryptedRecord): LightCheckpoint {
  if (record.version !== 1) throw new Error('unsupported light checkpoint envelope');
  const nonce = hexToBytes(record.nonce);
  if (nonce.length !== 24) throw new Error('invalid light checkpoint nonce');
  const { key, aad } = material(scope);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, nonce, aad).decrypt(hexToBytes(record.ciphertext));
  } catch {
    throw new Error('light checkpoint authentication failed');
  }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== LIGHT_CHECKPOINT_VERSION) {
    throw new Error('invalid light checkpoint payload');
  }
  return parsed as LightCheckpoint;
}

/** In-memory backend used by non-browser clients and deterministic tests. Records remain encrypted. */
export class MemoryLightCheckpointStore implements LightCheckpointStore {
  readonly records = new Map<string, EncryptedRecord>();

  async load(scope: LightCheckpointScope): Promise<LightCheckpoint | null> {
    const record = this.records.get(material(scope).id);
    return record ? open(scope, record) : null;
  }

  async save(scope: LightCheckpointScope, checkpoint: LightCheckpoint): Promise<void> {
    this.records.set(material(scope).id, seal(scope, checkpoint));
  }

  async delete(scope: LightCheckpointScope): Promise<void> {
    this.records.delete(material(scope).id);
  }
}

const DB_NAME = 'protocol404-light-wallet';
const STORE_NAME = 'checkpoints';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Browser persistence. Any IndexedDB failure is surfaced so callers never mistake memory for durable storage. */
export class IndexedDbLightCheckpointStore implements LightCheckpointStore {
  readonly #indexedDB: IDBFactory;

  constructor(indexedDB: IDBFactory = globalThis.indexedDB) {
    if (!indexedDB) throw new Error('IndexedDB is unavailable');
    this.#indexedDB = indexedDB;
  }

  async #database(): Promise<IDBDatabase> {
    const request = this.#indexedDB.open(DB_NAME, LIGHT_CHECKPOINT_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    return requestResult(request);
  }

  async load(scope: LightCheckpointScope): Promise<LightCheckpoint | null> {
    const db = await this.#database();
    try {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const record = await requestResult(transaction.objectStore(STORE_NAME).get(material(scope).id)) as EncryptedRecord | undefined;
      return record ? open(scope, record) : null;
    } finally { db.close(); }
  }

  async save(scope: LightCheckpointScope, checkpoint: LightCheckpoint): Promise<void> {
    const db = await this.#database();
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const completed = transactionResult(transaction);
      await requestResult(transaction.objectStore(STORE_NAME).put(seal(scope, checkpoint), material(scope).id));
      await completed;
    } finally { db.close(); }
  }

  async delete(scope: LightCheckpointScope): Promise<void> {
    const db = await this.#database();
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const completed = transactionResult(transaction);
      await requestResult(transaction.objectStore(STORE_NAME).delete(material(scope).id));
      await completed;
    } finally { db.close(); }
  }
}

let memoryStore: MemoryLightCheckpointStore | undefined;

export function defaultLightCheckpointStore(): LightCheckpointStore {
  if (typeof globalThis.indexedDB !== 'undefined') return new IndexedDbLightCheckpointStore(globalThis.indexedDB);
  return memoryStore ??= new MemoryLightCheckpointStore();
}
