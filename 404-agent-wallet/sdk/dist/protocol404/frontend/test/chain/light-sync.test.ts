import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToHex, zeroHash, type Hex } from 'viem';
import type { PoolConnection } from '../../src/chain/client.ts';
import { MemoryLightCheckpointStore } from '../../src/chain/light-store.ts';
import { syncLightPrivateNotes } from '../../src/chain/light-sync.ts';
import {
  createNote, deriveAddress, deriveKeys, deriveNoteSecrets, encryptOutgoingNote,
  IncrementalMerkleTree, noteCommitment,
} from '../../src/crypto/index.ts';

const poolAddress = '0x2222222222222222222222222222222222222222' as const;
const blockHash = `0x${'44'.repeat(32)}` as Hex;
const txHash = `0x${'55'.repeat(32)}` as Hex;

function fixture() {
  const keys = deriveKeys(new Uint8Array(32).fill(9));
  const address = deriveAddress(keys, new Uint8Array(11).fill(3));
  const context = { chainId: 56n, pool: new Uint8Array(20).fill(0x22) };
  const note = createNote(address, 42n, { asset: 1, rseed: new Uint8Array(32).fill(8) });
  const cm = noteCommitment(note, address.owner, deriveNoteSecrets(note.rseed).rcm);
  const tree = new IncrementalMerkleTree();
  tree.setLeaf(3, cm);
  const ciphertext = bytesToHex(encryptOutgoingNote(note, address, cm, keys.ovk, context));
  return { keys, note, cm, tree, ciphertext };
}

function server(options: {
  badRoot?: boolean; badPath?: boolean; staleCursor?: boolean; anchorHash?: Hex;
  nextIndex?: string; interruptCursor?: string; spent?: boolean;
} = {}) {
  const data = fixture();
  const seen: string[] = [];
  const root = options.badRoot ? data.tree.root() + 1n : data.tree.root();
  const canonicalHash = options.anchorHash ?? blockHash;
  const nextIndex = options.nextIndex ?? '4';
  const anchor = {
    version: 1, chainId: 56, pool: poolAddress, blockNumber: '10', blockHash: canonicalHash, timestamp: '100',
    root: root.toString(), nextIndex, nullifierCount: '0', nullifierDigest: zeroHash, transactionDigest: zeroHash,
  };
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    seen.push(`${url.pathname}?${url.searchParams.toString()}`);
    if (url.pathname === '/pool/checkpoint') return Response.json(anchor);
    if (url.pathname === '/pool/path') return Response.json({
      checkpoint: anchor, leafIndex: url.searchParams.get('leafIndex'), commitment: data.cm.toString(),
      path: data.tree.path(3).map((value, index) => (options.badPath && index === 0 ? value + 1n : value).toString()),
    });
    if (url.pathname === '/pool/notes') {
      const cursor = url.searchParams.get('cursor');
      if (options.interruptCursor === cursor) throw new Error('simulated scan interruption');
      if (cursor === nextIndex) throw new Error('completed cursor must not fetch notes');
      if (nextIndex === '8' && cursor === '4') return Response.json({ checkpoint: anchor, notes: [], nextCursor: '8', done: true });
      return Response.json({
        checkpoint: anchor,
        notes: [{ leafIndex: '3', commitment: data.cm.toString(), ciphertext: data.ciphertext, blockNumber: '9', transactionHash: txHash }],
        nextCursor: options.staleCursor ? cursor : '4', done: !options.staleCursor && nextIndex !== '8',
      });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  };
  const client = {
    getBlock: async (request?: { blockNumber?: bigint }) => request?.blockNumber === undefined
      ? { number: 10n, hash: canonicalHash, timestamp: 100n }
      : { number: request.blockNumber, hash: canonicalHash, timestamp: 100n },
    getLogs: async () => [],
  };
  const pool = { read: {
    currentRoot: async () => data.tree.root(), nextIndex: async () => BigInt(nextIndex), nullifierCount: async () => 0n,
    nullifierDigest: async () => zeroHash, transactionDigest: async () => zeroHash, nullified: async () => options.spent ?? false,
  } };
  const config = { chain: { id: 56 }, deployBlock: 1n, contracts: { pool: poolAddress }, noteIndexerUrls: ['https://indexer.example'] };
  return { data, seen, fetcher: fetcher as typeof fetch, connection: { client, pool, config } as unknown as PoolConnection };
}

test('discovers an owned note before fetching its path, then verifies the anchored path on demand', async () => {
  const { data, seen, fetcher, connection } = server();
  const snapshot = await syncLightPrivateNotes(connection, data.keys, undefined, { fetch: fetcher, store: new MemoryLightCheckpointStore() });

  assert.equal(snapshot.owned.length, 1);
  assert.equal(snapshot.owned[0]!.note.value, 42n);
  assert.equal(snapshot.tree.root(), data.tree.root());
  assert.equal(seen.some(request => request.startsWith('/pool/path?')), false);
  await (snapshot as typeof snapshot & { ensurePaths(indices: readonly number[]): Promise<void> }).ensurePaths([3]);
  assert.deepEqual(snapshot.tree.path(3), data.tree.path(3));
  assert.equal(seen.some(request => request.startsWith('/pool/path?')), true);
});

test('encrypted checkpoint resume skips previously scanned pages and lazily restores paths', async () => {
  const store = new MemoryLightCheckpointStore();
  const first = server();
  await syncLightPrivateNotes(first.connection, first.data.keys, undefined, { fetch: first.fetcher, store });

  const second = server();
  const snapshot = await syncLightPrivateNotes(second.connection, second.data.keys, undefined, { fetch: second.fetcher, store });
  assert.equal(second.seen.some(request => request.startsWith('/pool/notes?')), false);
  assert.throws(() => snapshot.tree.path(3), /no witness/);
  await (snapshot as typeof snapshot & { ensurePaths(indices: readonly number[]): Promise<void> }).ensurePaths([3]);
  assert.deepEqual(snapshot.tree.path(3), second.data.tree.path(3));
});

test('saves each completed notes page and resumes after an interrupted scan', async () => {
  const store = new MemoryLightCheckpointStore();
  const first = server({ nextIndex: '8', interruptCursor: '4' });
  await assert.rejects(
    syncLightPrivateNotes(first.connection, first.data.keys, undefined, { fetch: first.fetcher, store }),
    /simulated scan interruption/,
  );

  const second = server({ nextIndex: '8' });
  await syncLightPrivateNotes(second.connection, second.data.keys, undefined, { fetch: second.fetcher, store });
  const notesRequests = second.seen.filter(request => request.startsWith('/pool/notes?'));
  assert.equal(notesRequests.length, 1);
  assert.match(notesRequests[0]!, /cursor=4/);
});

test('a non-canonical saved anchor is discarded and discovery restarts from the safe block', async () => {
  const store = new MemoryLightCheckpointStore();
  const first = server();
  await syncLightPrivateNotes(first.connection, first.data.keys, undefined, { fetch: first.fetcher, store, fromBlock: 3n });

  const second = server({ anchorHash: `0x${'66'.repeat(32)}` });
  await syncLightPrivateNotes(second.connection, second.data.keys, undefined, { fetch: second.fetcher, store, fromBlock: 3n });
  const notesRequest = second.seen.find(request => request.startsWith('/pool/notes?'));
  assert.match(notesRequest ?? '', /cursor=0/);
  assert.match(notesRequest ?? '', /fromBlock=3/);
});

test('rejects an RPC-inconsistent checkpoint and a forged owned-note path', async () => {
  const wrongRoot = server({ badRoot: true });
  await assert.rejects(
    syncLightPrivateNotes(wrongRoot.connection, wrongRoot.data.keys, undefined, { fetch: wrongRoot.fetcher, store: new MemoryLightCheckpointStore() }),
    /checkpoint differs from on-chain pool state/,
  );

  const badPath = server({ badPath: true });
  const badPathSnapshot = await syncLightPrivateNotes(
    badPath.connection, badPath.data.keys, undefined, { fetch: badPath.fetcher, store: new MemoryLightCheckpointStore() },
  );
  await assert.rejects(
    (badPathSnapshot as typeof badPathSnapshot & { ensurePaths(indices: readonly number[]): Promise<void> }).ensurePaths([3]),
    /Merkle path does not match root/,
  );
});

test('checks spent status before allowing a path fetch', async () => {
  const spent = server({ spent: true });
  const snapshot = await syncLightPrivateNotes(spent.connection, spent.data.keys, undefined, { fetch: spent.fetcher, store: new MemoryLightCheckpointStore() });
  assert.equal(snapshot.unspent.length, 0);
  await assert.rejects(
    (snapshot as typeof snapshot & { ensurePaths(indices: readonly number[]): Promise<void> }).ensurePaths([3]),
    /cannot fetch path for spent leaf/,
  );
  assert.equal(spent.seen.some(request => request.startsWith('/pool/path?')), false);
});

test('rejects a page cursor that does not advance', async () => {
  const stale = server({ staleCursor: true });
  await assert.rejects(
    syncLightPrivateNotes(stale.connection, stale.data.keys, undefined, { fetch: stale.fetcher, store: new MemoryLightCheckpointStore() }),
    /cursor did not advance/,
  );
});
