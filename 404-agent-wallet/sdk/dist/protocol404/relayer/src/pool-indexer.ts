import { concatHex, isHex, keccak256, numberToHex, type Address, type Hex } from "viem";
import { HttpError } from "./service.js";
import { PoolStore, type StoredCheckpoint, type StoredNote } from "./pool-store.js";

export type PoolEvent =
  | { kind: "note"; leafIndex: bigint; commitment: bigint; ciphertext: Hex; block: bigint; logIndex: number; tx: Hex }
  | { kind: "shielded"; leafIndex: bigint; asset: number; value: bigint; block: bigint; logIndex: number; tx: Hex }
  | { kind: "nullified"; nullifier: bigint; block: bigint; logIndex: number; tx: Hex }
  | { kind: "transacted"; requestDigest: Hex; block: bigint; logIndex: number; tx: Hex };

export type PoolChainState = {
  root: bigint; nextIndex: bigint; nullifierCount: bigint; nullifierDigest: Hex; transactionDigest: Hex;
};
export type PoolBlock = { number: bigint; hash: Hex; timestamp: bigint };
export interface PoolSource {
  blockNumber(): Promise<bigint>;
  block(blockNumber: bigint): Promise<PoolBlock>;
  events(fromBlock: bigint, toBlock: bigint): Promise<PoolEvent[]>;
  state(blockNumber: bigint): Promise<PoolChainState>;
}

export type PoolCheckpoint = {
  version: 1; chainId: number; pool: Address; blockNumber: string; blockHash: Hex; timestamp: string;
  root: string; nextIndex: string; nullifierCount: string; nullifierDigest: Hex; transactionDigest: Hex;
};
export type PoolAnchor = { block: bigint; hash: Hex };

const ZERO_DIGEST = numberToHex(0n, { size: 32 });

function wire(checkpoint: StoredCheckpoint): PoolCheckpoint {
  return {
    ...checkpoint, blockNumber: String(checkpoint.blockNumber), timestamp: String(checkpoint.timestamp), root: String(checkpoint.root),
    nextIndex: String(checkpoint.nextIndex), nullifierCount: String(checkpoint.nullifierCount),
  };
}

function compareEvents(a: PoolEvent, b: PoolEvent): number {
  return a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1;
}

function field(value: bigint, label: string): void {
  if (value < 0n || value >= 21888242871839275222246405745257275088548364400416034343698204186575808495617n) {
    throw new Error(`${label} is not a BN254 field element`);
  }
}

export class PoolIndexer {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  readonly source: PoolSource;
  readonly store: PoolStore;
  readonly deployBlock: bigint;
  readonly options: { pageSize?: bigint };

  constructor(
    source: PoolSource,
    store: PoolStore,
    deployBlock: bigint,
    options: { pageSize?: bigint } = {},
  ) {
    this.source = source;
    this.store = store;
    this.deployBlock = deployBlock;
    this.options = options;
    if (deployBlock !== store.scope.deployBlock) throw new Error("pool index deploy block does not match database scope");
    if ((options.pageSize ?? 2_000n) < 1n) throw new Error("pool index page size must be positive");
  }

  sync(): Promise<PoolCheckpoint> { return this.serial(() => this.syncUnlocked().then(wire)); }

  checkpoint(): Promise<PoolCheckpoint> { return this.sync(); }

  notes(anchor: PoolAnchor, cursor: bigint, limit: number, fromBlock?: bigint): Promise<unknown> {
    if (cursor < 0n) return Promise.reject(new HttpError(400, "invalid cursor"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 512) return Promise.reject(new HttpError(400, "invalid limit"));
    if (fromBlock !== undefined && fromBlock < 0n) return Promise.reject(new HttpError(400, "invalid fromBlock"));
    return this.serial(async () => {
      await this.syncUnlocked();
      const checkpoint = await this.anchor(anchor);
      if (cursor > checkpoint.nextIndex) throw new HttpError(400, "invalid cursor");
      const page = this.store.notes(checkpoint.blockNumber, cursor, limit, fromBlock);
      const notes = page.notes.map(note => this.noteWire(note));
      const nextCursor = page.more && page.notes.length ? String(page.notes.at(-1)!.leafIndex + 1n) : String(checkpoint.nextIndex);
      return { checkpoint: wire(checkpoint), notes, nextCursor, done: !page.more };
    });
  }

  path(anchor: PoolAnchor, leafIndex: bigint): Promise<unknown> {
    if (leafIndex < 0n) return Promise.reject(new HttpError(400, "leaf index out of range"));
    return this.serial(async () => {
      await this.syncUnlocked();
      const checkpoint = await this.anchor(anchor);
      if (leafIndex < 0n || leafIndex >= checkpoint.nextIndex) throw new HttpError(400, "leaf index out of range");
      return {
        checkpoint: wire(checkpoint), leafIndex: String(leafIndex), commitment: String(this.store.leaf(checkpoint.blockNumber, leafIndex)),
        path: this.store.path(checkpoint.blockNumber, leafIndex).map(String),
      };
    });
  }

  spends(anchor: PoolAnchor, ids: readonly bigint[]): Promise<unknown> {
    if (ids.length < 1 || ids.length > 64) return Promise.reject(new HttpError(400, "invalid nullifiers"));
    try { ids.forEach(value => field(value, "nullifier")); }
    catch { return Promise.reject(new HttpError(400, "invalid nullifiers")); }
    return this.serial(async () => {
      await this.syncUnlocked();
      const checkpoint = await this.anchor(anchor);
      return { checkpoint: wire(checkpoint), records: this.store.spends(checkpoint.blockNumber, ids).map(record => ({
        nullifier: String(record.nullifier), transactionHash: record.transactionHash, blockNumber: String(record.blockNumber),
      })) };
    });
  }

  requests(anchor: PoolAnchor, ids: readonly Hex[]): Promise<unknown> {
    if (ids.length < 1 || ids.length > 64 || ids.some(id => !isHex(id, { strict: true }) || id.length !== 66)) {
      return Promise.reject(new HttpError(400, "invalid request digests"));
    }
    return this.serial(async () => {
      await this.syncUnlocked();
      const checkpoint = await this.anchor(anchor);
      return { checkpoint: wire(checkpoint), records: this.store.requests(checkpoint.blockNumber, ids).map(record => ({
        requestDigest: record.requestDigest, transactionHash: record.transactionHash, blockNumber: String(record.blockNumber),
      })) };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
    this.store.close();
  }

  private async syncUnlocked(): Promise<StoredCheckpoint> {
    if (this.closed) throw new Error("pool indexer is closed");
    const head = await this.source.blockNumber();
    await this.recoverReorg(head);
    let previous = this.store.latestCheckpoint();
    let from = previous ? previous.blockNumber + 1n : this.deployBlock;
    const pageSize = this.options.pageSize ?? 2_000n;
    while (from <= head) {
      const to = from + pageSize - 1n < head ? from + pageSize - 1n : head;
      const before = await this.source.block(to);
      const [events, state] = await Promise.all([this.source.events(from, to), this.source.state(to)]);
      const after = await this.source.block(to);
      if (before.hash !== after.hash || before.number !== to || after.number !== to) throw new Error("chain reorganized while indexing; retry");
      this.validateState(state);
      const page = this.buildPage(events, from, to, previous, state);
      const current = await this.source.block(to);
      if (current.hash !== before.hash) throw new Error("chain reorganized while indexing; retry");
      const next: StoredCheckpoint = {
        version: 1, chainId: this.store.scope.chainId, pool: this.store.scope.pool, blockNumber: to,
        blockHash: before.hash, timestamp: before.timestamp, ...state,
      };
      this.store.commitPage({ checkpoint: next, ...page });
      previous = next;
      from = to + 1n;
    }
    const result = this.store.latestCheckpoint();
    if (!result) throw new Error("pool deployment block is ahead of the chain");
    return result;
  }

  private async recoverReorg(head: bigint): Promise<void> {
    const latest = this.store.latestCheckpoint();
    if (!latest) return;
    if (latest.blockNumber <= head && (await this.source.block(latest.blockNumber)).hash === latest.blockHash) return;
    let ancestor: StoredCheckpoint | undefined;
    for (const saved of this.store.checkpointsDescending()) {
      if (saved.blockNumber <= head && (await this.source.block(saved.blockNumber)).hash === saved.blockHash) { ancestor = saved; break; }
    }
    this.store.rollbackAfter(ancestor?.blockNumber);
  }

  private buildPage(events: PoolEvent[], from: bigint, to: bigint, previous: StoredCheckpoint | undefined, state: PoolChainState) {
    const sorted = [...events].sort(compareEvents);
    const publicValues = new Map<bigint, { asset: number; value: bigint }>();
    for (const event of sorted) {
      if (event.block < from || event.block > to || !Number.isInteger(event.logIndex) || event.logIndex < 0) throw new Error("malformed pool event position");
      if (!isHex(event.tx, { strict: true }) || event.tx.length !== 66) throw new Error("malformed pool event transaction hash");
      if (event.kind === "shielded") {
        if (!Number.isInteger(event.asset) || event.asset < 0 || event.asset > 0xffff_ffff || event.value < 0n) throw new Error("malformed shield event");
        if (publicValues.has(event.leafIndex)) throw new Error("duplicate shield event");
        publicValues.set(event.leafIndex, { asset: event.asset, value: event.value });
      }
    }
    const notes: StoredNote[] = [];
    const noteIndices = new Set<bigint>();
    const spends: { nullifier: bigint; transactionHash: Hex; blockNumber: bigint }[] = [];
    const requests: { requestDigest: Hex; transactionHash: Hex; blockNumber: bigint }[] = [];
    let nullifierDigest = previous?.nullifierDigest ?? ZERO_DIGEST;
    let transactionDigest = previous?.transactionDigest ?? ZERO_DIGEST;
    for (const event of sorted) {
      if (event.kind === "note") {
        field(event.commitment, "commitment");
        if (!isHex(event.ciphertext, { strict: true }) || event.ciphertext.length % 2 !== 0) throw new Error("malformed note ciphertext");
        if (event.leafIndex < (previous?.nextIndex ?? 0n) || event.leafIndex >= state.nextIndex || noteIndices.has(event.leafIndex)) throw new Error("missing or malformed note events");
        noteIndices.add(event.leafIndex);
        notes.push({ leafIndex: event.leafIndex, commitment: event.commitment, ciphertext: event.ciphertext, blockNumber: event.block,
          transactionHash: event.tx, publicValue: publicValues.get(event.leafIndex) });
      } else if (event.kind === "nullified") {
        field(event.nullifier, "nullifier");
        spends.push({ nullifier: event.nullifier, transactionHash: event.tx, blockNumber: event.block });
        nullifierDigest = keccak256(concatHex([nullifierDigest, numberToHex(event.nullifier, { size: 32 })]));
      } else if (event.kind === "transacted") {
        if (!isHex(event.requestDigest, { strict: true }) || event.requestDigest.length !== 66) throw new Error("malformed request digest");
        requests.push({ requestDigest: event.requestDigest, transactionHash: event.tx, blockNumber: event.block });
        transactionDigest = keccak256(concatHex([transactionDigest, event.requestDigest]));
      }
    }
    if (state.nullifierCount !== (previous?.nullifierCount ?? 0n) + BigInt(spends.length)
      || state.nullifierDigest !== nullifierDigest || state.transactionDigest !== transactionDigest) {
      throw new Error("events do not match on-chain counts or digests");
    }
    return { notes, spends, requests };
  }

  private validateState(state: PoolChainState): void {
    field(state.root, "root");
    if (state.nextIndex < 0n || state.nextIndex > 2n ** 32n || state.nextIndex % 2n !== 0n) throw new Error("malformed on-chain nextIndex");
    if (state.nullifierCount < 0n) throw new Error("malformed on-chain nullifierCount");
    for (const digest of [state.nullifierDigest, state.transactionDigest]) {
      if (!isHex(digest, { strict: true }) || digest.length !== 66) throw new Error("malformed on-chain digest");
    }
  }

  private async anchor(anchor: PoolAnchor): Promise<StoredCheckpoint> {
    const checkpoint = this.store.checkpointAt(anchor.block);
    if (!checkpoint || checkpoint.blockHash !== anchor.hash) throw new HttpError(409, "unknown or changed checkpoint anchor");
    if ((await this.source.block(anchor.block)).hash !== anchor.hash) throw new HttpError(409, "checkpoint anchor was reorganized");
    return checkpoint;
  }

  private noteWire(note: StoredNote): unknown {
    return {
      leafIndex: String(note.leafIndex), commitment: String(note.commitment), ciphertext: note.ciphertext,
      blockNumber: String(note.blockNumber), transactionHash: note.transactionHash,
      ...(note.publicValue ? { publicValue: { asset: note.publicValue.asset, value: String(note.publicValue.value) } } : {}),
    };
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
