import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { concatHex, keccak256, numberToHex, type Address, type Hex } from "viem";
import { PoolIndexer, type PoolChainState, type PoolEvent, type PoolSource } from "../src/pool-indexer.js";
import { EMPTY_ROOTS, PoolStore } from "../src/pool-store.js";
import { poseidonHash2 } from "../src/pool-poseidon.js";

const pool = "0x2222222222222222222222222222222222222222" as Address;
const hash = (value: number) => numberToHex(BigInt(value), { size: 32 });
const tx = (value: number) => hash(10_000 + value);
const zero = hash(0);

function root(leaves: bigint[]): bigint {
  let level = [...leaves];
  for (let depth = 0; depth < 32; depth++) {
    const next: bigint[] = [];
    for (let index = 0; index < level.length; index += 2) next.push(poseidonHash2(level[index]!, level[index + 1] ?? EMPTY_ROOTS[depth]!));
    level = next;
  }
  return level[0] ?? EMPTY_ROOTS[32]!;
}

function state(leaves: bigint[], nullifiers: bigint[] = [], requests: Hex[] = []): PoolChainState {
  let nullifierDigest = zero;
  for (const value of nullifiers) nullifierDigest = keccak256(concatHex([nullifierDigest, numberToHex(value, { size: 32 })]));
  let transactionDigest = zero;
  for (const value of requests) transactionDigest = keccak256(concatHex([transactionDigest, value]));
  return { root: root(leaves), nextIndex: BigInt(leaves.length), nullifierCount: BigInt(nullifiers.length), nullifierDigest, transactionDigest };
}

class MockSource implements PoolSource {
  head = 11n;
  readonly hashes = new Map<bigint, Hex>([[10n, hash(10)], [11n, hash(11)], [12n, hash(12)]]);
  readonly states = new Map<bigint, PoolChainState>();
  readonly logs = new Map<bigint, PoolEvent[]>();
  blockNumber = async () => this.head;
  async block(blockNumber: bigint) { return { number: blockNumber, hash: this.hashes.get(blockNumber)!, timestamp: 1_700_000_000n + blockNumber }; }
  async events(from: bigint, to: bigint) {
    return [...this.logs].filter(([block]) => block >= from && block <= to).flatMap(([, events]) => events);
  }
  async state(blockNumber: bigint) { return this.states.get(blockNumber)!; }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pool-index-"));
  const database = join(directory, "index.sqlite");
  const source = new MockSource();
  const request = hash(77);
  source.states.set(10n, state([5n, 0n]));
  source.logs.set(10n, [
    { kind: "note", leafIndex: 0n, commitment: 5n, ciphertext: "0x0102", block: 10n, logIndex: 1, tx: tx(1) },
    { kind: "shielded", leafIndex: 0n, asset: 1, value: 25n, block: 10n, logIndex: 2, tx: tx(1) },
  ]);
  source.states.set(11n, state([5n, 0n, 7n, 8n], [33n], [request]));
  source.logs.set(11n, [
    { kind: "nullified", nullifier: 33n, block: 11n, logIndex: 0, tx: tx(2) },
    { kind: "note", leafIndex: 2n, commitment: 7n, ciphertext: "0x03", block: 11n, logIndex: 1, tx: tx(2) },
    { kind: "note", leafIndex: 3n, commitment: 8n, ciphertext: "0x04", block: 11n, logIndex: 2, tx: tx(2) },
    { kind: "transacted", requestDigest: request, block: 11n, logIndex: 3, tx: tx(2) },
  ]);
  const open = () => {
    const store = new PoolStore(database, { chainId: 11155111, pool, deployBlock: 10n });
    return new PoolIndexer(source, store, 10n, { pageSize: 1n });
  };
  return { directory, database, source, request, open };
}

test("indexes real notes and padding with historical paths, pagination and disk restart", async () => {
  const value = fixture();
  try {
    let indexer = value.open();
    const latest = await indexer.sync();
    assert.equal(latest.root, String(root([5n, 0n, 7n, 8n])));
    const oldAnchor = { block: 10n, hash: hash(10) };
    const oldPath = await indexer.path(oldAnchor, 1n) as { commitment: string; path: string[]; checkpoint: { root: string } };
    assert.equal(oldPath.commitment, "0");
    let current = 0n;
    let position = 1;
    for (const sibling of oldPath.path) { current = position % 2 ? poseidonHash2(BigInt(sibling), current) : poseidonHash2(current, BigInt(sibling)); position = Math.floor(position / 2); }
    assert.equal(String(current), oldPath.checkpoint.root);

    const anchor = { block: 11n, hash: hash(11) };
    const first = await indexer.notes(anchor, 0n, 1) as { notes: unknown[]; nextCursor: string; done: boolean };
    assert.equal(first.notes.length, 1); assert.equal(first.nextCursor, "1"); assert.equal(first.done, false);
    const publicPage = await indexer.notes(anchor, 0n, 10, 10n) as { notes: Array<{ publicValue?: unknown }> };
    assert.deepEqual(publicPage.notes[0]!.publicValue, { asset: 1, value: "25" });
    await indexer.close();

    indexer = value.open();
    assert.equal((await indexer.checkpoint()).blockHash, hash(11));
    assert.equal(((await indexer.spends(anchor, [33n])) as { records: unknown[] }).records.length, 1);
    assert.equal(((await indexer.requests(anchor, [value.request])) as { records: unknown[] }).records.length, 1);
    await assert.rejects(() => indexer.spends(anchor, Array<bigint>(65).fill(1n)), /invalid nullifiers/);
    await indexer.close();
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test("bad root rolls back the whole page", async () => {
  const value = fixture();
  try {
    const indexer = value.open();
    await indexer.sync();
    value.source.head = 12n;
    value.source.states.set(12n, { ...value.source.states.get(11n)!, root: 123n });
    await assert.rejects(() => indexer.sync(), /root/);
    value.source.head = 11n;
    assert.equal((await indexer.checkpoint()).blockNumber, "11");
    await indexer.close();
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test("deep reorg searches saved checkpoints and removes orphan records", async () => {
  const value = fixture();
  try {
    const indexer = value.open();
    await indexer.sync();
    value.source.hashes.set(11n, hash(111));
    value.source.states.set(11n, state([5n, 0n, 9n, 10n]));
    value.source.logs.set(11n, [
      { kind: "note", leafIndex: 2n, commitment: 9n, ciphertext: "0x09", block: 11n, logIndex: 1, tx: tx(9) },
      { kind: "note", leafIndex: 3n, commitment: 10n, ciphertext: "0x0a", block: 11n, logIndex: 2, tx: tx(9) },
    ]);
    const next = await indexer.sync();
    assert.equal(next.blockHash, hash(111));
    const anchor = { block: 11n, hash: hash(111) };
    assert.equal(((await indexer.spends(anchor, [33n])) as { records: unknown[] }).records.length, 0);
    assert.equal(((await indexer.requests(anchor, [value.request])) as { records: unknown[] }).records.length, 0);
    assert.equal(((await indexer.path(anchor, 2n)) as { commitment: string }).commitment, "9");
    await assert.rejects(() => indexer.path({ block: 11n, hash: hash(11) }, 2n), /anchor/);
    await indexer.close();
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test("database refuses a different deployment scope and Poseidon matches the known vector", () => {
  assert.equal(poseidonHash2(0n, 0n), 5151499478991301833156025595048985053689893395646836724335623777508747990769n);
  const directory = mkdtempSync(join(tmpdir(), "pool-scope-"));
  const database = join(directory, "index.sqlite");
  try {
    new PoolStore(database, { chainId: 11155111, pool, deployBlock: 10n }).close();
    assert.throws(() => new PoolStore(database, { chainId: 11155111, pool, deployBlock: 9n }), /different deployment scope/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
