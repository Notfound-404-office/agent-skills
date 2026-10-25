import { DatabaseSync } from "node:sqlite";
import type { Address, Hex } from "viem";
import { poseidonHash2 } from "./pool-poseidon.js";

export const POOL_INDEX_SCHEMA = 1;
export const EMPTY_ROOTS: readonly bigint[] = (() => {
  const roots = [0n];
  for (let depth = 0; depth < 32; depth++) roots.push(poseidonHash2(roots[depth]!, roots[depth]!));
  return Object.freeze(roots);
})();

export type PoolScope = { chainId: number; pool: Address; deployBlock: bigint; schemaVersion?: number };
export type StoredCheckpoint = {
  version: 1; chainId: number; pool: Address; blockNumber: bigint; blockHash: Hex; timestamp: bigint;
  root: bigint; nextIndex: bigint; nullifierCount: bigint; nullifierDigest: Hex; transactionDigest: Hex;
};
export type StoredNote = {
  leafIndex: bigint; commitment: bigint; ciphertext: Hex; blockNumber: bigint; transactionHash: Hex;
  publicValue?: { asset: number; value: bigint };
};
export type StoredSpend = { nullifier: bigint; transactionHash: Hex; blockNumber: bigint };
export type StoredRequest = { requestDigest: Hex; transactionHash: Hex; blockNumber: bigint };

type NoteWrite = StoredNote;
type SpendWrite = StoredSpend;
type RequestWrite = StoredRequest;

function safe(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} exceeds SQLite integer range`);
  return number;
}

function checkpoint(row: Record<string, unknown>, scope: PoolScope): StoredCheckpoint {
  return {
    version: 1, chainId: scope.chainId, pool: scope.pool,
    blockNumber: BigInt(row.block_number as number), blockHash: row.block_hash as Hex,
    timestamp: BigInt(row.timestamp as string), root: BigInt(row.root as string),
    nextIndex: BigInt(row.next_index as string), nullifierCount: BigInt(row.nullifier_count as string),
    nullifierDigest: row.nullifier_digest as Hex, transactionDigest: row.transaction_digest as Hex,
  };
}

export class PoolStore {
  readonly scope: Required<PoolScope>;
  private readonly db: DatabaseSync;

  constructor(path: string, scope: PoolScope) {
    this.scope = { ...scope, schemaVersion: scope.schemaVersion ?? POOL_INDEX_SCHEMA };
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scope (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), chain_id INTEGER NOT NULL, pool TEXT NOT NULL,
        deploy_block TEXT NOT NULL, schema_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        block_number INTEGER PRIMARY KEY, block_hash TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL,
        root TEXT NOT NULL, next_index TEXT NOT NULL, nullifier_count TEXT NOT NULL,
        nullifier_digest TEXT NOT NULL, transaction_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        leaf_index INTEGER PRIMARY KEY, commitment TEXT NOT NULL, ciphertext TEXT NOT NULL,
        block_number INTEGER NOT NULL, transaction_hash TEXT NOT NULL, public_asset INTEGER, public_value TEXT
      );
      CREATE INDEX IF NOT EXISTS notes_block ON notes(block_number,leaf_index);
      CREATE TABLE IF NOT EXISTS spends (
        nullifier TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL, block_number INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spends_block ON spends(block_number);
      CREATE TABLE IF NOT EXISTS requests (
        request_digest TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL, block_number INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_block ON requests(block_number);
      CREATE TABLE IF NOT EXISTS nodes (
        block_number INTEGER NOT NULL, level INTEGER NOT NULL, node_index INTEGER NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY(block_number,level,node_index)
      );
      CREATE INDEX IF NOT EXISTS nodes_history ON nodes(level,node_index,block_number DESC);
    `);
    const existing = this.db.prepare("SELECT chain_id,pool,deploy_block,schema_version FROM scope WHERE singleton=1").get() as Record<string, unknown> | undefined;
    if (!existing) {
      this.db.prepare("INSERT INTO scope(singleton,chain_id,pool,deploy_block,schema_version) VALUES(1,?,?,?,?)")
        .run(this.scope.chainId, this.scope.pool.toLowerCase(), String(this.scope.deployBlock), this.scope.schemaVersion);
    } else if (Number(existing.chain_id) !== this.scope.chainId || String(existing.pool) !== this.scope.pool.toLowerCase()
      || String(existing.deploy_block) !== String(this.scope.deployBlock) || Number(existing.schema_version) !== this.scope.schemaVersion) {
      this.db.close();
      throw new Error("pool index database belongs to a different deployment scope");
    }
  }

  close(): void { this.db.close(); }

  latestCheckpoint(): StoredCheckpoint | undefined {
    const row = this.db.prepare("SELECT * FROM checkpoints ORDER BY block_number DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    return row && checkpoint(row, this.scope);
  }

  checkpointAt(blockNumber: bigint): StoredCheckpoint | undefined {
    const row = this.db.prepare("SELECT * FROM checkpoints WHERE block_number=?").get(safe(blockNumber, "block number")) as Record<string, unknown> | undefined;
    return row && checkpoint(row, this.scope);
  }

  checkpointsDescending(): StoredCheckpoint[] {
    return (this.db.prepare("SELECT * FROM checkpoints ORDER BY block_number DESC").all() as Record<string, unknown>[])
      .map(row => checkpoint(row, this.scope));
  }

  rollbackAfter(blockNumber?: bigint): void {
    const limit = blockNumber === undefined ? -1 : safe(blockNumber, "block number");
    this.transaction(() => {
      for (const table of ["nodes", "notes", "spends", "requests", "checkpoints"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE block_number>?`).run(limit);
      }
    });
  }

  commitPage(value: {
    checkpoint: StoredCheckpoint; notes: NoteWrite[]; spends: SpendWrite[]; requests: RequestWrite[];
  }): void {
    const block = safe(value.checkpoint.blockNumber, "block number");
    const previous = this.latestCheckpoint();
    const startIndex = previous?.nextIndex ?? 0n;
    const byIndex = new Map(value.notes.map(note => [note.leafIndex, note]));
    this.transaction(() => {
      for (const note of value.notes) {
        this.db.prepare(`INSERT INTO notes(leaf_index,commitment,ciphertext,block_number,transaction_hash,public_asset,public_value)
          VALUES(?,?,?,?,?,?,?)`).run(
          safe(note.leafIndex, "leaf index"), String(note.commitment), note.ciphertext, safe(note.blockNumber, "block number"),
          note.transactionHash, note.publicValue?.asset ?? null, note.publicValue ? String(note.publicValue.value) : null,
        );
      }
      for (const spend of value.spends) this.db.prepare("INSERT INTO spends VALUES(?,?,?)")
        .run(String(spend.nullifier), spend.transactionHash, safe(spend.blockNumber, "block number"));
      for (const request of value.requests) this.db.prepare("INSERT INTO requests VALUES(?,?,?)")
        .run(request.requestDigest, request.transactionHash, safe(request.blockNumber, "block number"));

      for (let index = startIndex; index < value.checkpoint.nextIndex; index++) {
        this.setNode(block, 0, safe(index, "leaf index"), byIndex.get(index)?.commitment ?? 0n);
        let position = safe(index, "leaf index");
        for (let level = 0; level < 32; level++) {
          const left = position - (position % 2);
          const leftHash = this.nodeAt(block, level, left);
          const rightHash = this.nodeAt(block, level, left + 1);
          position = Math.floor(position / 2);
          this.setNode(block, level + 1, position, poseidonHash2(leftHash, rightHash));
        }
      }
      if (this.nodeAt(block, 32, 0) !== value.checkpoint.root) throw new Error("events do not match on-chain root");
      this.db.prepare(`INSERT INTO checkpoints(block_number,block_hash,timestamp,root,next_index,nullifier_count,nullifier_digest,transaction_digest)
        VALUES(?,?,?,?,?,?,?,?)`).run(
        block, value.checkpoint.blockHash, String(value.checkpoint.timestamp), String(value.checkpoint.root),
        String(value.checkpoint.nextIndex), String(value.checkpoint.nullifierCount), value.checkpoint.nullifierDigest,
        value.checkpoint.transactionDigest,
      );
    });
  }

  notes(anchor: bigint, cursor: bigint, limit: number, fromBlock?: bigint): { notes: StoredNote[]; more: boolean } {
    const params: Array<number> = [safe(anchor, "block number"), safe(cursor, "cursor")];
    let filter = "block_number<=? AND leaf_index>=?";
    if (fromBlock !== undefined) { filter += " AND block_number>=?"; params.push(safe(fromBlock, "fromBlock")); }
    params.push(limit + 1);
    const rows = this.db.prepare(`SELECT * FROM notes WHERE ${filter} ORDER BY leaf_index LIMIT ?`).all(...params) as Record<string, unknown>[];
    const more = rows.length > limit;
    return { notes: rows.slice(0, limit).map(row => ({
      leafIndex: BigInt(row.leaf_index as number), commitment: BigInt(row.commitment as string), ciphertext: row.ciphertext as Hex,
      blockNumber: BigInt(row.block_number as number), transactionHash: row.transaction_hash as Hex,
      ...(row.public_asset === null ? {} : { publicValue: { asset: Number(row.public_asset), value: BigInt(row.public_value as string) } }),
    })), more };
  }

  path(anchor: bigint, leafIndex: bigint): bigint[] {
    let position = safe(leafIndex, "leaf index");
    const block = safe(anchor, "block number");
    const result: bigint[] = [];
    for (let level = 0; level < 32; level++) {
      result.push(this.nodeAt(block, level, position % 2 === 0 ? position + 1 : position - 1));
      position = Math.floor(position / 2);
    }
    return result;
  }

  leaf(anchor: bigint, leafIndex: bigint): bigint { return this.nodeAt(safe(anchor, "block number"), 0, safe(leafIndex, "leaf index")); }

  spends(anchor: bigint, ids: readonly bigint[]): StoredSpend[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM spends WHERE block_number<=? AND nullifier IN (${ids.map(() => "?").join(",")})`)
      .all(safe(anchor, "block number"), ...ids.map(String)) as Record<string, unknown>[];
    return rows.map(row => ({ nullifier: BigInt(row.nullifier as string), transactionHash: row.transaction_hash as Hex, blockNumber: BigInt(row.block_number as number) }));
  }

  requests(anchor: bigint, ids: readonly Hex[]): StoredRequest[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM requests WHERE block_number<=? AND request_digest IN (${ids.map(() => "?").join(",")})`)
      .all(safe(anchor, "block number"), ...ids) as Record<string, unknown>[];
    return rows.map(row => ({ requestDigest: row.request_digest as Hex, transactionHash: row.transaction_hash as Hex, blockNumber: BigInt(row.block_number as number) }));
  }

  private nodeAt(block: number, level: number, nodeIndex: number): bigint {
    const row = this.db.prepare("SELECT hash FROM nodes WHERE level=? AND node_index=? AND block_number<=? ORDER BY block_number DESC LIMIT 1")
      .get(level, nodeIndex, block) as { hash: string } | undefined;
    return row ? BigInt(row.hash) : EMPTY_ROOTS[level]!;
  }

  private setNode(block: number, level: number, nodeIndex: number, hash: bigint): void {
    this.db.prepare("INSERT INTO nodes(block_number,level,node_index,hash) VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET hash=excluded.hash")
      .run(block, level, nodeIndex, String(hash));
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
