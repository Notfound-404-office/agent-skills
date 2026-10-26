import { bytesToHex, concatHex, hexToBytes, keccak256, numberToHex, type Hex } from 'viem';
import { rawAbis } from '../abi/index.ts';
import { decryptIncomingNote, decryptOutgoingNote, IncrementalMerkleTree, noteLocation, noteNullifier, type KeyMaterial, type Note } from '../crypto/index.ts';
import type { PoolConnection } from './client.ts';

export type OwnedNote = { leafIndex: number; cm: bigint; note: Note; nf: bigint; publicValue: boolean };
export type PrivateSnapshot = {
  tree: IncrementalMerkleTree;
  owned: OwnedNote[];
  spent: Set<bigint>;
  executed: Set<Hex>;
  executedTransactions?: Map<Hex, Hex>;
  unspent: OwnedNote[];
  head: { number: bigint; hash: Hex; timestamp: bigint };
};
export type VerifiedCheckpoint = Readonly<{
  version: 1;
  chainId: number;
  pool: Hex;
  keyDigest: Hex;
  spentDigest: Hex;
  transactionDigest: Hex;
  span: string;
  snapshot: Readonly<{
    head: Readonly<{ number: string; hash: Hex; timestamp: string }>;
    tree: readonly (readonly string[])[];
    owned: readonly Readonly<{ leafIndex: number; cm: string; nf: string; publicValue: boolean; note: Readonly<{ asset: 0 | 1; d: Hex; value: string; lockUntil: string; rseed: Hex; memo: Hex }> }>[];
    spent: readonly string[];
    executed: readonly Hex[];
    executedTransactions: readonly (readonly [Hex, Hex])[];
  }>;
}>;

export interface VerifiedCheckpointStore {
  load(): Promise<VerifiedCheckpoint | null>;
  save(checkpoint: VerifiedCheckpoint): Promise<void>;
  clear?(): Promise<void>;
}

type VerifiedCache = { snapshot: PrivateSnapshot; spentDigest: Hex; transactionDigest: Hex; span: bigint };
const verified = new WeakMap<PoolConnection, WeakMap<KeyMaterial, VerifiedCache>>();

/** @orig index-CVtw0LZh.js:27800 nO Cache only verified anchors; never trust a reorged snapshot. */
export async function syncPrivateNotes(connection: PoolConnection, keys: KeyMaterial, onProgress?: (block: bigint, head: bigint) => void, checkpointStore?: VerifiedCheckpointStore): Promise<PrivateSnapshot> {
  let cache = verified.get(connection);
  if (!cache) { cache = new WeakMap(); verified.set(connection, cache); }
  let previous = cache.get(keys);
  if (!previous && checkpointStore) {
    const persisted = await checkpointStore.load();
    if (persisted) {
      const restored = restoreCheckpoint(connection, keys, persisted);
      if (restored) { previous = restored; cache.set(keys, restored); }
      else await checkpointStore.clear?.().catch(() => undefined);
    }
  }
  try { return await syncSnapshot(connection, keys, cache, previous, onProgress, checkpointStore); }
  catch (error) {
    if (!previous || !/missing|duplicate|events do not match|reorganized/i.test(String(error))) throw error;
    cache.delete(keys);
    await checkpointStore?.clear?.().catch(() => undefined);
    return syncSnapshot(connection, keys, cache, undefined, onProgress, checkpointStore);
  }
}

/** @orig index-CVtw0LZh.js:26264 AE + :27105 jD.ingest Incrementally read a pinned chain snapshot. */
async function syncSnapshot(connection: PoolConnection, keys: KeyMaterial, cache: WeakMap<KeyMaterial, VerifiedCache>, previous?: VerifiedCache, onProgress?: (block: bigint, head: bigint) => void, checkpointStore?: VerifiedCheckpointStore): Promise<PrivateSnapshot> {
  const { client, config, pool } = connection;
  const head = await client.getBlock();
  if (config.deployBlock > head.number) throw new Error('Deployment block is ahead of the chain');
  if (previous && (head.number < previous.snapshot.head.number || (await client.getBlock({ blockNumber: previous.snapshot.head.number })).hash !== previous.snapshot.head.hash)) previous = undefined;
  const events = rawAbis.pool.filter(entry => entry.type === 'event');
  const getWindow = (from: bigint, to: bigint) => client.getLogs({ address: config.contracts.pool, events, fromBlock: from, toBlock: to, strict: true });
  const spent = new Set(previous?.snapshot.spent);
  const executed = new Set(previous?.snapshot.executed);
  const executedTransactions = new Map(previous?.snapshot.executedTransactions);
  let spentDigest: Hex = previous?.spentDigest ?? numberToHex(0n, { size: 32 });
  let transactionDigest: Hex = previous?.transactionDigest ?? numberToHex(0n, { size: 32 });
  const tree = new IncrementalMerkleTree();
  // Clone cached levels so a failed/reorganized scan cannot mutate the verified snapshot.
  if (previous) for (let depth = 0; depth < 33; depth++) tree.levels[depth] = previous.snapshot.tree.levels[depth]!.slice();
  const owned: OwnedNote[] = previous ? [...previous.snapshot.owned] : [];
  const context = { chainId: BigInt(config.chain.id), pool: hexToBytes(config.contracts.pool) };
  let span = previous?.span ?? 5000n;
  for (let from = previous ? previous.snapshot.head.number + 1n : config.deployBlock; from <= head.number;) {
    const to = from + span - 1n < head.number ? from + span - 1n : head.number;
    let page;
    try {
      page = await getWindow(from, to);
    } catch (error) {
      if (span > 1n && /range|too many (logs|results)|response size/i.test(String(error))) { span /= 2n; continue; }
      throw error;
    }
    page.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
    const deposits = new Map<number, { asset: 0 | 1; value: bigint }>();
    for (const event of page) {
      if (event.eventName === 'Shielded') {
        if (event.args.asset !== 0 && event.args.asset !== 1) throw new Error('Unknown deposit asset');
        deposits.set(Number(event.args.leafIndex), { asset: event.args.asset, value: event.args.amount });
      } else if (event.eventName === 'Nullified') {
        if (spent.has(event.args.nullifier)) throw new Error('Duplicate nullifier event');
        spent.add(event.args.nullifier);
        spentDigest = keccak256(concatHex([spentDigest, numberToHex(event.args.nullifier, { size: 32 })]));
      } else if (event.eventName === 'Transacted') {
        if (executed.has(event.args.requestDigest)) throw new Error('Duplicate transaction digest event');
        executed.add(event.args.requestDigest);
        executedTransactions.set(event.args.requestDigest, event.transactionHash);
        transactionDigest = keccak256(concatHex([transactionDigest, event.args.requestDigest]));
      }
    }
    for (const event of page) {
      if (event.eventName !== 'NoteAdded') continue;
      const { leafIndex, commitment, ciphertext } = event.args;
      const index = Number(leafIndex);
      if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 32 || index < tree.size || index > tree.size + 1) throw new Error('Missing or malformed note events');
      tree.setLeaf(index, commitment);
      const bytes = hexToBytes(ciphertext);
      const deposit = deposits.get(index);
      const note = decryptOutgoingNote(bytes, commitment, keys, context, deposit) ?? decryptIncomingNote(bytes, commitment, keys, context, deposit);
      if (note) owned.push({ leafIndex: index, cm: commitment, note, nf: noteNullifier(keys.nk, noteLocation(commitment, leafIndex)), publicValue: deposit !== undefined });
    }
    // Persist only after the whole window has been decoded and applied. The
    // next invocation revalidates this anchor's block hash before continuing.
    if (checkpointStore) {
      const anchor = await client.getBlock({ blockNumber: to });
      const partialSnapshot = {
        tree, owned, spent, executed, executedTransactions,
        unspent: owned.filter(note => note.note.value > 0n && !spent.has(note.nf)),
        head: { number: to, hash: anchor.hash, timestamp: anchor.timestamp },
      };
      await checkpointStore.save(makeCheckpoint(connection, keys, { snapshot: partialSnapshot, spentDigest, transactionDigest, span }));
    }
    onProgress?.(to, head.number);
    from = to + 1n;
  }
  const [root, nullifierCount, chainSpentDigest, chainTransactionDigest] = await Promise.all([
    pool.read.currentRoot({ blockNumber: head.number }), pool.read.nullifierCount({ blockNumber: head.number }),
    pool.read.nullifierDigest({ blockNumber: head.number }), pool.read.transactionDigest({ blockNumber: head.number }),
  ]);
  if (tree.root() !== root || BigInt(spent.size) !== nullifierCount || spentDigest !== chainSpentDigest || transactionDigest !== chainTransactionDigest) {
    throw new Error('Events do not match the on-chain root or digests; use another RPC');
  }
  if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('Chain reorganized while syncing; retry');
  const snapshot = { tree, owned, spent, executed, executedTransactions, unspent: owned.filter(note => note.note.value > 0n && !spent.has(note.nf)), head };
  const result = { snapshot, spentDigest, transactionDigest, span };
  if (checkpointStore) await checkpointStore.save(makeCheckpoint(connection, keys, result));
  cache.set(keys, result);
  return snapshot;
}

function makeCheckpoint(connection: PoolConnection, keys: KeyMaterial, value: VerifiedCache): VerifiedCheckpoint {
  const { snapshot } = value;
  snapshot.tree.root();
  return {
    version: 1, chainId: connection.config.chain.id, pool: connection.config.contracts.pool,
    keyDigest: keccak256(keys.seed), spentDigest: value.spentDigest, transactionDigest: value.transactionDigest,
    span: value.span.toString(),
    snapshot: {
      head: { number: snapshot.head.number.toString(), hash: snapshot.head.hash, timestamp: snapshot.head.timestamp.toString() },
      tree: snapshot.tree.levels.map(level => level.map(item => item.toString())),
      owned: snapshot.owned.map(({ leafIndex, cm, nf, publicValue, note }) => ({
        leafIndex, cm: cm.toString(), nf: nf.toString(), publicValue,
        note: { asset: note.asset, d: bytesToHex(note.d), value: note.value.toString(), lockUntil: note.lockUntil.toString(), rseed: bytesToHex(note.rseed), memo: bytesToHex(note.memo) },
      })),
      spent: [...snapshot.spent].map(item => item.toString()),
      executed: [...snapshot.executed],
      executedTransactions: [...(snapshot.executedTransactions ?? new Map())],
    },
  };
}

function restoreCheckpoint(connection: PoolConnection, keys: KeyMaterial, value: VerifiedCheckpoint): VerifiedCache | undefined {
  if (value?.version !== 1 || value.chainId !== connection.config.chain.id || value.pool.toLowerCase() !== connection.config.contracts.pool.toLowerCase()
    || value.keyDigest.toLowerCase() !== keccak256(keys.seed).toLowerCase() || !value.snapshot || !Array.isArray(value.snapshot.tree) || value.snapshot.tree.length !== 33) return undefined;
  try {
    const tree = new IncrementalMerkleTree();
    tree.levels.splice(0, tree.levels.length, ...value.snapshot.tree.map((level: readonly string[]) => level.map((item: string) => BigInt(item))));
    const owned = value.snapshot.owned.map(item => ({
      leafIndex: item.leafIndex, cm: BigInt(item.cm), nf: BigInt(item.nf), publicValue: item.publicValue,
      note: { asset: item.note.asset, d: hexToBytes(item.note.d), value: BigInt(item.note.value), lockUntil: BigInt(item.note.lockUntil), rseed: hexToBytes(item.note.rseed), memo: hexToBytes(item.note.memo) },
    }));
    const spent = new Set(value.snapshot.spent.map(BigInt));
    const snapshot = {
      tree, owned, spent, executed: new Set(value.snapshot.executed),
      executedTransactions: new Map(value.snapshot.executedTransactions),
      unspent: owned.filter(note => note.note.value > 0n && !spent.has(note.nf)),
      head: { number: BigInt(value.snapshot.head.number), hash: value.snapshot.head.hash, timestamp: BigInt(value.snapshot.head.timestamp) },
    };
    return { snapshot, spentDigest: value.spentDigest, transactionDigest: value.transactionDigest, span: BigInt(value.span) };
  } catch { return undefined; }
}
