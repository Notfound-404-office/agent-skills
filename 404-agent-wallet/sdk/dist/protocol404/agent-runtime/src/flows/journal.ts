import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { deriveBytes, utf8, type KeyMaterial } from '../crypto/index.ts';
import type { RelayPath } from '../relayer-client/index.ts';

export type JournalStatus = 'prepared' | 'exported' | 'unknown' | 'submitted' | 'observed' | 'conflicted';
export type JournalRecord = {
  id: string;
  createdAt: number;
  status: JournalStatus;
  intent: Record<string, string>;
  path: RelayPath;
  transport?: 'self';
  relayerUrl?: string;
  body: unknown;
  authorization?: string;
  nullifiers: string[];
  expectedDigests: Hex[];
  requiresExternalObservation?: boolean;
  txHash?: Hex;
};

type SealedRecord = { version: 1; id: string; nonce: Hex; ciphertext: Hex };
export type JournalStore = {
  readAll(): Promise<unknown[]>;
  put(record: SealedRecord): Promise<void>;
  remove?(id: string): Promise<void>;
};

/** Browser IndexedDB storage; strict transaction durability is requested where supported. */
export class IndexedDbJournalStore implements JournalStore {
  private readonly prefix: string;
  constructor(prefix: string) { this.prefix = prefix; }

  private async db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(LEGACY_JOURNAL_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('journal');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async readAll(): Promise<unknown[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('journal', 'readonly');
      const request = transaction.objectStore('journal').getAll(IDBKeyRange.bound(this.prefix, `${this.prefix}\uffff`));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async put(record: SealedRecord): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('journal', 'readwrite', { durability: 'strict' });
      transaction.objectStore('journal').put(record, `${this.prefix}${record.id}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }

  async remove(id: string): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('journal', 'readwrite', { durability: 'strict' });
      transaction.objectStore('journal').delete(`${this.prefix}${id}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }
}

/** @orig index-CVtw0LZh.js:27633-27789 HD Encrypted durable journal for uncertain relayer submissions. */
export class PendingJournal {
  private readonly records = new Map<string, JournalRecord>();
  private readonly key: Uint8Array;
  private readonly domain: string;
  readonly scope: string;

  readonly store: JournalStore;
  constructor(keys: KeyMaterial, chainId: number, pool: Hex, store: JournalStore) {
    this.store = store;
    this.domain = `pm/journal/v1/${chainId}/${pool.toLowerCase()}`;
    this.scope = bytesToHex(deriveBytes(keys.seed, `${this.domain}/id`, 16)).slice(2);
    this.key = deriveBytes(keys.seed, `${this.domain}/encryption`, 32);
  }

  async load(): Promise<void> {
    const loaded = new Map<string, JournalRecord>();
    for (const value of await this.store.readAll()) {
      const record = this.open(value);
      if (!record || loaded.has(record.id)) throw new Error('damaged transaction journal; saved payment outcome may be unknown');
      loaded.set(record.id, record);
    }
    this.records.clear();
    for (const [id, record] of loaded) this.records.set(id, record);
  }

  list(): JournalRecord[] {
    return [...this.records.values()].sort((left, right) => right.createdAt - left.createdAt).map(record => structuredClone(record));
  }

  get(id: string): JournalRecord {
    const record = this.records.get(id);
    if (!record) throw new Error('unknown transaction journal entry');
    return structuredClone(record);
  }

  unresolvedNullifiers(): Set<bigint> {
    return new Set(this.list().filter(record => ['prepared', 'exported', 'unknown', 'submitted'].includes(record.status)).flatMap(record => record.nullifiers).map(BigInt));
  }

  async add(record: Omit<JournalRecord, 'id' | 'createdAt' | 'status'>): Promise<JournalRecord> {
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16))).slice(2);
    const value: JournalRecord = { ...structuredClone(record), id, createdAt: Date.now(), status: 'prepared' };
    await this.persist(value);
    return structuredClone(value);
  }

  async mark(id: string, status: JournalStatus, txHash?: Hex): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error('unknown transaction journal entry');
    await this.persist({ ...record, status, ...(txHash ? { txHash } : {}) });
  }

  /** Remove only a request never posted or explicitly rejected before broadcast. */
  async discardPrepared(id: string): Promise<void> {
    const record = this.get(id);
    if (record.status !== 'prepared') throw new Error('only a request that was never broadcast can be discarded; void it instead');
    if (!this.store.remove) throw new Error('this journal storage cannot discard records');
    await this.store.remove(id);
    this.records.delete(id);
  }

  /** @orig index-CVtw0LZh.js:27846 HD.reconcile Match the exact pool request digest; nullifier use alone can only prove conflict. */
  async reconcile(spent: ReadonlySet<bigint>, executed: ReadonlySet<Hex>, executedTransactions?: ReadonlyMap<Hex, Hex>): Promise<void> {
    const normalizedExecuted = new Set([...executed].map(value => value.toLowerCase()));
    const normalizedTransactions = executedTransactions && new Map(
      [...executedTransactions].map(([digest, hash]) => [digest.toLowerCase(), hash] as const),
    );
    for (const record of this.records.values()) {
      // Pre-reconstruction records did not persist the digest and cannot be reconciled safely.
      if (!Array.isArray(record.expectedDigests)) {
        if (record.status === 'observed') continue;
        if (['observed', 'conflicted'].includes(record.status)) {
          await this.mark(record.id, record.txHash ? 'submitted' : 'unknown');
        }
        continue;
      }
      const exactDigests = record.expectedDigests.length > 0
        && record.expectedDigests.every(value => normalizedExecuted.has(value.toLowerCase()));
      const hashes = exactDigests && normalizedTransactions
        ? record.expectedDigests.map(value => normalizedTransactions.get(value.toLowerCase()))
        : [];
      const canonicalHash = hashes.length > 0 && hashes.every(hash => hash
        && hash.toLowerCase() === hashes[0]!.toLowerCase()) ? hashes[0] : undefined;
      // Legacy snapshots have no digest-to-transaction map. New verified snapshots require every
      // digest of a bundled request to come from the same canonical transaction.
      const exact = exactDigests && (!normalizedTransactions || canonicalHash !== undefined);
      // External submissions are finalized by their receipt/event reconciler.
      // Once that path marks a record observed, private-pool reconciliation
      // must not downgrade it back to submitted on every later sync.
      const terminalExternal = record.status === 'observed'
        && (record.requiresExternalObservation || record.intent.kind === 'release');
      const next = terminalExternal ? 'observed' : exact
        ? record.requiresExternalObservation ? 'submitted' : 'observed'
        : record.nullifiers.some(value => spent.has(BigInt(value))) ? 'conflicted'
          : ['observed', 'conflicted'].includes(record.status) ? record.txHash ? 'submitted' : 'unknown'
            : record.status;
      const hash = exact && !record.requiresExternalObservation ? canonicalHash ?? record.txHash : record.txHash;
      if (next !== record.status || hash !== record.txHash) await this.mark(record.id, next, hash);
    }
  }

  private open(value: unknown): JournalRecord | null {
    if (!value || typeof value !== 'object') return null;
    const sealed = value as Partial<SealedRecord>;
    if (sealed.version !== 1 || typeof sealed.id !== 'string' || !/^[0-9a-f]{32}$/.test(sealed.id)
      || typeof sealed.nonce !== 'string' || typeof sealed.ciphertext !== 'string') return null;
    try {
      const plaintext = xchacha20poly1305(this.key, hexToBytes(sealed.nonce), utf8(`${this.domain}/${sealed.id}`)).decrypt(hexToBytes(sealed.ciphertext));
      let record: JournalRecord;
      try { record = JSON.parse(new TextDecoder().decode(plaintext)) as JournalRecord; }
      finally { plaintext.fill(0); }
      if (record.id !== sealed.id || !['prepared', 'exported', 'unknown', 'submitted', 'observed', 'conflicted'].includes(record.status)) return null;
      return record;
    } catch {
      return null;
    }
  }

  private async persist(record: JournalRecord): Promise<void> {
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const plaintext = utf8(JSON.stringify(record));
    let ciphertext: Uint8Array;
    try { ciphertext = xchacha20poly1305(this.key, nonce, utf8(`${this.domain}/${record.id}`)).encrypt(plaintext); }
    finally { plaintext.fill(0); }
    await this.store.put({ version: 1, id: record.id, nonce: bytesToHex(nonce), ciphertext: bytesToHex(ciphertext) });
    this.records.set(record.id, structuredClone(record));
  }
}
import { LEGACY_JOURNAL_DB } from '../compatibility.ts';
