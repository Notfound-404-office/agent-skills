import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToHex, zeroHash, type Hex } from 'viem';
import type { PoolConnection } from '../../src/chain/client.ts';
import { syncPrivateNotes, type VerifiedCheckpoint } from '../../src/chain/sync.ts';
import {
  createNote, deriveAddress, deriveKeys, deriveNoteSecrets, encryptOutgoingNote,
  IncrementalMerkleTree, noteCommitment,
} from '../../src/crypto/index.ts';

const poolAddress = '0x2222222222222222222222222222222222222222' as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;

type TestLog = {
  blockNumber: bigint;
  logIndex: number;
  eventName: 'NoteAdded' | 'Shielded';
  args: Record<string, unknown>;
};

function noteFixture() {
  const keys = deriveKeys(new Uint8Array(32));
  const address = deriveAddress(keys, new Uint8Array(11));
  const context = { chainId: 56n, pool: new Uint8Array(20).fill(0x22) };
  const regular = createNote(address, 25n, { asset: 0, rseed: new Uint8Array(32).fill(1) });
  const open = createNote(address, 75n, { asset: 1, rseed: new Uint8Array(32).fill(2) });
  const commitments = [regular, open].map(note => noteCommitment(note, address.owner, deriveNoteSecrets(note.rseed).rcm));
  const tree = new IncrementalMerkleTree();
  commitments.forEach((commitment, index) => tree.setLeaf(index, commitment));
  return { keys, address, context, regular, open, commitments, tree };
}

function connectionFixture(options: {
  head: () => { number: bigint; hash: Hex; timestamp: bigint };
  blockHash?: (number: bigint) => Hex;
  logs: (from: bigint, to: bigint) => TestLog[] | Promise<TestLog[]>;
  root: () => bigint;
}) {
  const requests: Array<[bigint, bigint]> = [];
  const client = {
    getBlock: async (request?: { blockNumber?: bigint }) => request?.blockNumber === undefined
      ? options.head()
      : { number: request.blockNumber, hash: options.blockHash?.(request.blockNumber) ?? options.head().hash, timestamp: 1n },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      requests.push([fromBlock, toBlock]);
      return options.logs(fromBlock, toBlock);
    },
  };
  const pool = { read: {
    currentRoot: async () => options.root(),
    nullifierCount: async () => 0n,
    nullifierDigest: async () => zeroHash,
    transactionDigest: async () => zeroHash,
  } };
  const config = { chain: { id: 56 }, deployBlock: 1n, contracts: { pool: poolAddress } };
  return { connection: { client, pool, config } as unknown as PoolConnection, requests };
}

test('streams each page before fetching the next and resolves open-value metadata within that page', async () => {
  const fixture = noteFixture();
  let firstCiphertextRead = false;
  const first: TestLog = {
    blockNumber: 1n, logIndex: 0, eventName: 'NoteAdded',
    args: {
      leafIndex: 0n, commitment: fixture.commitments[0],
      get ciphertext() {
        firstCiphertextRead = true;
        return bytesToHex(encryptOutgoingNote(fixture.regular, fixture.address, fixture.commitments[0]!, fixture.keys.ovk, fixture.context));
      },
    },
  };
  const openCiphertext = bytesToHex(encryptOutgoingNote(
    { ...fixture.open, value: 0n }, fixture.address, null, fixture.keys.ovk, fixture.context,
  ));
  const secondPage: TestLog[] = [
    {
      blockNumber: 5001n, logIndex: 2, eventName: 'Shielded',
      args: { leafIndex: 1n, asset: 1, amount: fixture.open.value },
    },
    {
      blockNumber: 5001n, logIndex: 1, eventName: 'NoteAdded',
      args: { leafIndex: 1n, commitment: fixture.commitments[1], ciphertext: openCiphertext },
    },
  ];
  const progress: Array<[bigint, bigint]> = [];
  const { connection, requests } = connectionFixture({
    head: () => ({ number: 5001n, hash: hash('1'), timestamp: 10n }),
    logs: (from) => {
      if (from === 5001n) {
        assert.equal(firstCiphertextRead, true, 'the prior page must be processed before the next fetch');
        assert.deepEqual(progress, [[5000n, 5001n]], 'progress must follow completed page processing');
        return secondPage;
      }
      return [first];
    },
    root: () => fixture.tree.root(),
  });

  const snapshot = await syncPrivateNotes(connection, fixture.keys, (block, head) => progress.push([block, head]));

  assert.deepEqual(requests, [[1n, 5000n], [5001n, 5001n]]);
  assert.deepEqual(progress, [[5000n, 5001n], [5001n, 5001n]]);
  assert.deepEqual(snapshot.owned.map(note => [note.note.asset, note.note.value, note.publicValue]), [
    [0, 25n, false], [1, 75n, true],
  ]);
});

test('a rejected last page reports processed progress without mutating the prior verified snapshot', async () => {
  const fixture = noteFixture();
  let mode: 'initial' | 'bad' = 'initial';
  const initialHead = { number: 1n, hash: hash('2'), timestamp: 10n };
  const badHead = { number: 5001n, hash: hash('3'), timestamp: 20n };
  const regularCiphertext = bytesToHex(encryptOutgoingNote(
    fixture.regular, fixture.address, fixture.commitments[0]!, fixture.keys.ovk, fixture.context,
  ));
  const initialLog: TestLog = {
    blockNumber: 1n, logIndex: 0, eventName: 'NoteAdded',
    args: { leafIndex: 0n, commitment: fixture.commitments[0], ciphertext: regularCiphertext },
  };
  const badLog: TestLog = {
    blockNumber: 5001n, logIndex: 0, eventName: 'NoteAdded',
    args: { leafIndex: 1n, commitment: fixture.commitments[1], ciphertext: '0x' },
  };
  const initialTree = new IncrementalMerkleTree();
  initialTree.setLeaf(0, fixture.commitments[0]!);
  const progress: Array<[bigint, bigint]> = [];
  const { connection } = connectionFixture({
    head: () => mode === 'initial' ? initialHead : badHead,
    blockHash: number => number === 1n ? initialHead.hash : badHead.hash,
    logs: (from) => mode === 'initial' || from === 1n ? [initialLog] : [badLog],
    root: () => mode === 'initial' ? initialTree.root() : 123n,
  });
  const verified = await syncPrivateNotes(connection, fixture.keys);
  const verifiedRoot = verified.tree.root();

  mode = 'bad';
  await assert.rejects(syncPrivateNotes(connection, fixture.keys, (block, head) => progress.push([block, head])), /events do not match/i);

  assert.deepEqual(progress, [[5001n, 5001n], [5000n, 5001n], [5001n, 5001n]]);
  assert.equal(verified.tree.root(), verifiedRoot);
  assert.equal(verified.tree.size, 1);
  assert.equal(verified.owned.length, 1);
});

test('a changed cached head hash invalidates the cache and restarts at the deployment block', async () => {
  const fixture = noteFixture();
  let reorged = false;
  const oldHead = { number: 1n, hash: hash('4'), timestamp: 10n };
  const newHead = { number: 2n, hash: hash('5'), timestamp: 20n };
  const ciphertext = bytesToHex(encryptOutgoingNote(
    fixture.regular, fixture.address, fixture.commitments[0]!, fixture.keys.ovk, fixture.context,
  ));
  const log: TestLog = {
    blockNumber: 1n, logIndex: 0, eventName: 'NoteAdded',
    args: { leafIndex: 0n, commitment: fixture.commitments[0], ciphertext },
  };
  const tree = new IncrementalMerkleTree();
  tree.setLeaf(0, fixture.commitments[0]!);
  const { connection, requests } = connectionFixture({
    head: () => reorged ? newHead : oldHead,
    blockHash: number => reorged ? (number === 1n ? hash('6') : newHead.hash) : oldHead.hash,
    logs: () => [log],
    root: () => tree.root(),
  });
  await syncPrivateNotes(connection, fixture.keys);
  reorged = true;
  await syncPrivateNotes(connection, fixture.keys);

  assert.deepEqual(requests, [[1n, 1n], [1n, 2n]]);
});

test('restores a verified checkpoint across connections without rescanning old blocks', async () => {
  const fixture = noteFixture();
  const head = { number: 1n, hash: hash('7'), timestamp: 10n };
  const ciphertext = bytesToHex(encryptOutgoingNote(fixture.regular, fixture.address, fixture.commitments[0]!, fixture.keys.ovk, fixture.context));
  const log: TestLog = { blockNumber: 1n, logIndex: 0, eventName: 'NoteAdded', args: { leafIndex: 0n, commitment: fixture.commitments[0], ciphertext } };
  const tree = new IncrementalMerkleTree(); tree.setLeaf(0, fixture.commitments[0]!);
  let stored: VerifiedCheckpoint | null = null;
  const store = { load: async () => stored, save: async (value: VerifiedCheckpoint) => { stored = value; } };
  const first = connectionFixture({ head: () => head, logs: () => [log], root: () => tree.root() });
  await syncPrivateNotes(first.connection, fixture.keys, undefined, store);
  const second = connectionFixture({ head: () => head, logs: () => { throw new Error('old blocks were rescanned'); }, root: () => tree.root() });
  await syncPrivateNotes(second.connection, fixture.keys, undefined, store);
  assert.deepEqual(second.requests, []);
});

test('resumes from the last completed window after an interrupted scan', async () => {
  const fixture = noteFixture();
  const head = { number: 5001n, hash: hash('8'), timestamp: 10n };
  const ciphertext = bytesToHex(encryptOutgoingNote(fixture.regular, fixture.address, fixture.commitments[0]!, fixture.keys.ovk, fixture.context));
  const log: TestLog = { blockNumber: 1n, logIndex: 0, eventName: 'NoteAdded', args: { leafIndex: 0n, commitment: fixture.commitments[0], ciphertext } };
  const tree = new IncrementalMerkleTree(); tree.setLeaf(0, fixture.commitments[0]!);
  let stored: VerifiedCheckpoint | null = null;
  const store = { load: async () => stored, save: async (value: VerifiedCheckpoint) => { stored = value; } };
  const interrupted = connectionFixture({
    head: () => head, logs: (from) => { if (from > 1n) throw new Error('interrupted'); return [log]; }, root: () => tree.root(),
  });
  await assert.rejects(syncPrivateNotes(interrupted.connection, fixture.keys, undefined, store), /interrupted/);
  const resumed = connectionFixture({ head: () => head, logs: () => [], root: () => tree.root() });
  await syncPrivateNotes(resumed.connection, fixture.keys, undefined, store);
  assert.deepEqual(resumed.requests, [[5001n, 5001n]]);
});
