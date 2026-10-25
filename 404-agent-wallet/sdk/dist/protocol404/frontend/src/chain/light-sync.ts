import { bytesToHex, hexToBytes, isAddressEqual, type Hex } from 'viem';
import { rawAbis } from '../abi/index.ts';
import {
  BN254_FIELD_MODULUS, LightWitnessTree, NOTE_CIPHERTEXT_LENGTH, U64_MAX, addressOwner, assertAsset,
  decryptIncomingNote, decryptOutgoingNote, deriveNoteSecrets, noteCommitment, noteLocation,
  noteNullifier, type KeyMaterial, type Note, type NoteWitnessTree,
} from '../crypto/index.ts';
import type { PoolConnection } from './client.ts';
import type { OwnedNote, PrivateSnapshot } from './sync.ts';
import {
  LIGHT_CHECKPOINT_VERSION, defaultLightCheckpointStore, type LightCheckpoint,
  type LightCheckpointScope, type LightCheckpointStore, type StoredLightNote,
} from './light-store.ts';

const U32_LIMIT = 1n << 32n;
const LEGACY_NOTE_CIPHERTEXT_LENGTH = 172;
const PAGE_LIMIT = 512;
const STATUS_CONCURRENCY = 16;
const PATH_CONCURRENCY = 8;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

type Anchor = Readonly<{
  version: 1;
  chainId: number;
  pool: `0x${string}`;
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  root: bigint;
  nextIndex: bigint;
  nullifierCount: bigint;
  nullifierDigest: Hex;
  transactionDigest: Hex;
}>;

type NoteRecord = Readonly<{
  leafIndex: number;
  commitment: bigint;
  ciphertext: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  publicValue?: Readonly<{ asset: 0 | 1; value: bigint }>;
}>;

export type LightSyncOptions = Readonly<{
  fromBlock?: bigint;
  trackedNullifiers?: ReadonlySet<bigint>;
  trackedDigests?: readonly Hex[];
  store?: LightCheckpointStore;
  fetch?: typeof globalThis.fetch;
}>;

type LightSnapshot = PrivateSnapshot & { tree: NoteWitnessTree; ensurePaths(indices: readonly number[]): Promise<void> };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function decimal(value: unknown, label: string, max?: bigint): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a canonical decimal string`);
  const parsed = BigInt(value);
  if (max !== undefined && parsed > max) throw new RangeError(`${label} out of range`);
  return parsed;
}

function integer(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`${label} out of range`);
  return value;
}

function hash(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} must be 32-byte hex`);
  return value as Hex;
}

function checkpoint(value: unknown, connection: PoolConnection): Anchor {
  const item = record(value, 'checkpoint');
  if (item.version !== 1) throw new Error('unsupported indexer version');
  const chainId = integer(item.chainId, 'checkpoint.chainId', Number.MAX_SAFE_INTEGER);
  if (chainId !== connection.config.chain.id) throw new Error('indexer chain does not match configuration');
  if (typeof item.pool !== 'string' || !ADDRESS.test(item.pool) || !isAddressEqual(item.pool as Hex, connection.config.contracts.pool)) {
    throw new Error('indexer pool does not match configuration');
  }
  return {
    version: 1, chainId, pool: item.pool as `0x${string}`,
    blockNumber: decimal(item.blockNumber, 'checkpoint.blockNumber', U64_MAX),
    blockHash: hash(item.blockHash, 'checkpoint.blockHash'),
    timestamp: decimal(item.timestamp, 'checkpoint.timestamp', U64_MAX),
    root: decimal(item.root, 'checkpoint.root', BN254_FIELD_MODULUS - 1n),
    nextIndex: decimal(item.nextIndex, 'checkpoint.nextIndex', U32_LIMIT),
    nullifierCount: decimal(item.nullifierCount, 'checkpoint.nullifierCount', U64_MAX),
    nullifierDigest: hash(item.nullifierDigest, 'checkpoint.nullifierDigest'),
    transactionDigest: hash(item.transactionDigest, 'checkpoint.transactionDigest'),
  };
}

function sameAnchor(left: Anchor, right: Anchor): boolean {
  return left.version === right.version && left.chainId === right.chainId && isAddressEqual(left.pool, right.pool)
    && left.blockNumber === right.blockNumber && left.blockHash.toLowerCase() === right.blockHash.toLowerCase()
    && left.timestamp === right.timestamp && left.root === right.root && left.nextIndex === right.nextIndex
    && left.nullifierCount === right.nullifierCount
    && left.nullifierDigest.toLowerCase() === right.nullifierDigest.toLowerCase()
    && left.transactionDigest.toLowerCase() === right.transactionDigest.toLowerCase();
}

async function getJson(fetcher: typeof globalThis.fetch, base: string, path: string, query?: Record<string, string>): Promise<unknown> {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  const response = await fetcher(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`note indexer returned HTTP ${response.status}`);
  return response.json();
}

async function verifyAnchor(connection: PoolConnection, anchor: Anchor, initialHead: bigint): Promise<void> {
  const block = await connection.client.getBlock({ blockNumber: anchor.blockNumber });
  if (!block.hash || block.hash.toLowerCase() !== anchor.blockHash.toLowerCase()) throw new Error('note indexer checkpoint block hash is not canonical');
  if (block.timestamp !== anchor.timestamp) throw new Error('note indexer checkpoint timestamp differs from RPC');
  const [root, nextIndex, nullifierCount, nullifierDigest, transactionDigest] = await Promise.all([
    connection.pool.read.currentRoot({ blockNumber: anchor.blockNumber }),
    connection.pool.read.nextIndex({ blockNumber: anchor.blockNumber }),
    connection.pool.read.nullifierCount({ blockNumber: anchor.blockNumber }),
    connection.pool.read.nullifierDigest({ blockNumber: anchor.blockNumber }),
    connection.pool.read.transactionDigest({ blockNumber: anchor.blockNumber }),
  ]);
  if (root !== anchor.root || nextIndex !== anchor.nextIndex || nullifierCount !== anchor.nullifierCount
    || nullifierDigest.toLowerCase() !== anchor.nullifierDigest.toLowerCase()
    || transactionDigest.toLowerCase() !== anchor.transactionDigest.toLowerCase()) {
    throw new Error('note indexer checkpoint differs from on-chain pool state');
  }
}

function parseNote(value: unknown, anchor: Anchor): NoteRecord {
  const item = record(value, 'note');
  const leaf = decimal(item.leafIndex, 'note.leafIndex', U32_LIMIT - 1n);
  const ciphertext = item.ciphertext;
  if (typeof ciphertext !== 'string' || !HEX.test(ciphertext)) throw new Error('note.ciphertext must be hex');
  const cipherLength = (ciphertext.length - 2) / 2;
  if (cipherLength !== NOTE_CIPHERTEXT_LENGTH && cipherLength !== LEGACY_NOTE_CIPHERTEXT_LENGTH) throw new Error('note ciphertext has invalid length');
  const blockNumber = decimal(item.blockNumber, 'note.blockNumber', anchor.blockNumber);
  let publicValue: NoteRecord['publicValue'];
  if (item.publicValue !== undefined) {
    const open = record(item.publicValue, 'note.publicValue');
    publicValue = { asset: assertAsset(integer(open.asset, 'note.publicValue.asset', 1)), value: decimal(open.value, 'note.publicValue.value', U64_MAX) };
  }
  return {
    leafIndex: Number(leaf), commitment: decimal(item.commitment, 'note.commitment', BN254_FIELD_MODULUS - 1n),
    ciphertext: ciphertext as Hex, blockNumber, transactionHash: hash(item.transactionHash, 'note.transactionHash'), publicValue,
  };
}

function restoreNote(value: StoredLightNote, keys: KeyMaterial): OwnedNote {
  const item = record(value, 'stored note') as StoredLightNote;
  const leafIndex = integer(item.leafIndex, 'stored note leafIndex', 0xffff_ffff);
  const cm = decimal(item.cm, 'stored note commitment', BN254_FIELD_MODULUS - 1n);
  const nf = decimal(item.nf, 'stored note nullifier', BN254_FIELD_MODULUS - 1n);
  const asset = assertAsset(integer(item.asset, 'stored note asset', 1));
  if (typeof item.publicValue !== 'boolean') throw new Error('stored note publicValue must be boolean');
  for (const [name, value, length] of [['d', item.d, 11], ['rseed', item.rseed, 32], ['memo', item.memo, 63]] as const) {
    if (typeof value !== 'string' || !HEX.test(value) || hexToBytes(value).length !== length) throw new Error(`stored note ${name} is invalid`);
  }
  const note: Note = {
    asset, d: hexToBytes(item.d), value: decimal(item.value, 'stored note value', U64_MAX),
    lockUntil: decimal(item.lockUntil, 'stored note lockUntil', U64_MAX), rseed: hexToBytes(item.rseed), memo: hexToBytes(item.memo),
  };
  const expectedCm = noteCommitment(note, addressOwner(keys.spendPub, keys.nkc, note.d), deriveNoteSecrets(note.rseed).rcm);
  const expectedNf = noteNullifier(keys.nk, noteLocation(expectedCm, BigInt(leafIndex)));
  if (expectedCm !== cm || expectedNf !== nf) throw new Error('stored owned note failed self-validation');
  return { leafIndex, cm, nf, note, publicValue: item.publicValue };
}

function storeNote(owned: OwnedNote): StoredLightNote {
  return {
    leafIndex: owned.leafIndex, cm: owned.cm.toString(), nf: owned.nf.toString(), publicValue: owned.publicValue,
    asset: owned.note.asset, d: bytesToHex(owned.note.d), value: owned.note.value.toString(),
    lockUntil: owned.note.lockUntil.toString(), rseed: bytesToHex(owned.note.rseed), memo: bytesToHex(owned.note.memo),
  };
}

function restoreCheckpoint(value: LightCheckpoint, keys: KeyMaterial): { blockNumber: bigint; blockHash: Hex; timestamp: bigint; cursor: bigint; fromBlock: bigint; owned: OwnedNote[] } {
  const item = record(value, 'stored checkpoint') as unknown as LightCheckpoint;
  if (item.version !== LIGHT_CHECKPOINT_VERSION || !Array.isArray(item.owned)) throw new Error('invalid stored light checkpoint');
  const anchor = record(item.anchor, 'stored anchor');
  return {
    blockNumber: decimal(anchor.blockNumber, 'stored blockNumber', U64_MAX), blockHash: hash(anchor.blockHash, 'stored blockHash'),
    timestamp: decimal(anchor.timestamp, 'stored timestamp', U64_MAX), cursor: decimal(item.cursor, 'stored cursor', U32_LIMIT),
    fromBlock: decimal(item.fromBlock, 'stored fromBlock', U64_MAX), owned: item.owned.map(note => restoreNote(note, keys)),
  };
}

async function mapConcurrent<T>(values: readonly T[], limit: number, action: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) { const value = values[cursor++]!; await action(value); }
  }));
}

async function verifiedExecutions(connection: PoolConnection, digests: readonly Hex[], blockNumber: bigint): Promise<{ executed: Set<Hex>; transactions: Map<Hex, Hex> }> {
  const executed = new Set<Hex>();
  const transactions = new Map<Hex, Hex>();
  const event = rawAbis.pool.find(item => item.type === 'event' && item.name === 'Transacted');
  if (!event) throw new Error('Transacted ABI is unavailable');
  for (const digest of new Set(digests.map(value => hash(value, 'tracked digest').toLowerCase() as Hex))) {
    const logs = await connection.client.getLogs({
      address: connection.config.contracts.pool, event, args: { requestDigest: digest },
      fromBlock: connection.config.deployBlock, toBlock: blockNumber, strict: true,
    });
    for (const log of logs) {
      if (log.args.requestDigest?.toLowerCase() !== digest || !log.transactionHash) throw new Error('malformed Transacted RPC log');
      executed.add(digest); transactions.set(digest, log.transactionHash);
    }
  }
  return { executed, transactions };
}

async function syncFromIndexer(
  base: string, connection: PoolConnection, keys: KeyMaterial, initialHead: { number: bigint },
  onProgress: ((block: bigint, head: bigint) => void) | undefined, options: LightSyncOptions,
  store: LightCheckpointStore, scope: LightCheckpointScope, stored: ReturnType<typeof restoreCheckpoint> | undefined,
): Promise<PrivateSnapshot> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new Error('fetch is unavailable');
  const target = checkpoint(await getJson(fetcher, base, 'pool/checkpoint'), connection);
  await verifyAnchor(connection, target, initialHead.number);

  let owned = stored?.owned.slice() ?? [];
  let cursor = stored?.cursor ?? 0n;
  let fromBlock = stored?.fromBlock ?? options.fromBlock ?? connection.config.deployBlock;
  if (fromBlock < connection.config.deployBlock || fromBlock > target.blockNumber) throw new RangeError('light sync fromBlock is out of range');
  if (cursor > target.nextIndex) { owned = []; cursor = 0n; fromBlock = options.fromBlock ?? connection.config.deployBlock; }
  const ownedIndices = new Set(owned.map(note => note.leafIndex));
  const tree = new LightWitnessTree(target.root);
  const context = { chainId: BigInt(connection.config.chain.id), pool: hexToBytes(connection.config.contracts.pool) };

  const fetchPath = async (index: number, expectedCommitment: bigint): Promise<void> => {
    const body = record(await getJson(fetcher, base, 'pool/path', {
      block: target.blockNumber.toString(), hash: target.blockHash, leafIndex: String(index),
    }), 'path response');
    const anchored = checkpoint(body.checkpoint, connection);
    if (!sameAnchor(anchored, target)) throw new Error('path response changed the fixed checkpoint');
    if (decimal(body.leafIndex, 'path.leafIndex', U32_LIMIT - 1n) !== BigInt(index)) throw new Error('path leaf index mismatch');
    if (decimal(body.commitment, 'path.commitment', BN254_FIELD_MODULUS - 1n) !== expectedCommitment) throw new Error('path commitment mismatch');
    if (!Array.isArray(body.path) || body.path.length !== 32) throw new Error('path must contain 32 siblings');
    tree.addWitness(index, expectedCommitment, body.path.map((sibling, depth) => decimal(sibling, `path[${depth}]`, BN254_FIELD_MODULUS - 1n)));
  };

  const saveCheckpoint = async (): Promise<void> => {
    await store.save(scope, {
      version: LIGHT_CHECKPOINT_VERSION,
      anchor: { blockNumber: target.blockNumber.toString(), blockHash: target.blockHash, timestamp: target.timestamp.toString() },
      cursor: cursor.toString(), fromBlock: fromBlock.toString(), owned: owned.map(storeNote),
    });
  };

  while (cursor < target.nextIndex) {
    const body = record(await getJson(fetcher, base, 'pool/notes', {
      block: target.blockNumber.toString(), hash: target.blockHash, cursor: cursor.toString(), limit: String(PAGE_LIMIT), fromBlock: fromBlock.toString(),
    }), 'notes response');
    const anchored = checkpoint(body.checkpoint, connection);
    if (!sameAnchor(anchored, target)) throw new Error('notes response changed the fixed checkpoint');
    if (!Array.isArray(body.notes) || body.notes.length > PAGE_LIMIT || typeof body.done !== 'boolean') throw new Error('malformed notes page');
    const nextCursor = decimal(body.nextCursor, 'notes.nextCursor', target.nextIndex);
    if (nextCursor <= cursor) throw new Error('notes cursor did not advance');
    let previousIndex = cursor - 1n;
    for (const raw of body.notes) {
      const item = parseNote(raw, target);
      if (item.blockNumber < fromBlock) throw new Error('note precedes requested discovery block');
      if (BigInt(item.leafIndex) < cursor || BigInt(item.leafIndex) >= nextCursor || BigInt(item.leafIndex) <= previousIndex) throw new Error('notes are outside cursor range or unordered');
      previousIndex = BigInt(item.leafIndex);
      const bytes = hexToBytes(item.ciphertext);
      const note = decryptOutgoingNote(bytes, item.commitment, keys, context, item.publicValue)
        ?? decryptIncomingNote(bytes, item.commitment, keys, context, item.publicValue);
      if (!note) continue;
      if (ownedIndices.has(item.leafIndex)) throw new Error('duplicate owned note');
      const nf = noteNullifier(keys.nk, noteLocation(item.commitment, BigInt(item.leafIndex)));
      owned.push({ leafIndex: item.leafIndex, cm: item.commitment, note, nf, publicValue: item.publicValue !== undefined });
      ownedIndices.add(item.leafIndex);
    }
    if (body.done !== (nextCursor === target.nextIndex) || (body.done && nextCursor !== target.nextIndex)) throw new Error('notes page has inconsistent completion state');
    cursor = nextCursor;
    // Persist every completed page. A later failure resumes at this cursor and
    // never replays already committed discovery work.
    await saveCheckpoint();
    onProgress?.(target.blockNumber, target.blockNumber);
  }

  const status = new Map<bigint, boolean>();
  const candidates = [...new Set([...owned.filter(item => item.note.value > 0n).map(item => item.nf), ...(options.trackedNullifiers ?? [])])];
  for (const nf of candidates) if (nf < 0n || nf >= BN254_FIELD_MODULUS) throw new RangeError('tracked nullifier out of range');
  await mapConcurrent(candidates, STATUS_CONCURRENCY, async nf => {
    status.set(nf, await connection.pool.read.nullified([nf], { blockNumber: target.blockNumber }));
  });
  const spent = new Set([...status].filter(([, isSpent]) => isSpent).map(([nf]) => nf));
  const { executed, transactions } = await verifiedExecutions(connection, options.trackedDigests ?? [], target.blockNumber);
  const canonical = await connection.client.getBlock({ blockNumber: target.blockNumber });
  if (!canonical.hash || canonical.hash.toLowerCase() !== target.blockHash.toLowerCase()) throw new Error('chain reorganized while light syncing');

  const ensurePaths = async (indices: readonly number[]): Promise<void> => {
    const byIndex = new Map(owned.map(note => [note.leafIndex, note]));
    const pending: Array<{ index: number; cm: bigint }> = [];
    for (const rawIndex of new Set(indices)) {
      const index = integer(rawIndex, 'leaf index', 0xffff_ffff);
      const note = byIndex.get(index);
      if (!note) throw new Error(`cannot fetch path for unowned leaf ${index}`);
      if (note.note.value <= 0n || spent.has(note.nf)) throw new Error(`cannot fetch path for spent leaf ${index}`);
      try { tree.path(index); } catch { pending.push({ index, cm: note.cm }); }
    }
    await mapConcurrent(pending, PATH_CONCURRENCY, async ({ index, cm }) => fetchPath(index, cm));
  };
  const snapshot = {
    tree, owned, spent, executed, executedTransactions: transactions,
    unspent: owned.filter(note => note.note.value > 0n && !spent.has(note.nf)),
    head: { number: target.blockNumber, hash: target.blockHash, timestamp: target.timestamp }, ensurePaths,
  } as unknown as LightSnapshot;
  await saveCheckpoint();
  return snapshot;
}

/** Synchronize private notes through configured public note indexers without uploading viewing keys. */
export async function syncLightPrivateNotes(
  connection: PoolConnection, keys: KeyMaterial, onProgress?: (block: bigint, head: bigint) => void,
  options: LightSyncOptions = {},
): Promise<PrivateSnapshot> {
  const urls = (connection.config as typeof connection.config & { noteIndexerUrls?: readonly string[] }).noteIndexerUrls ?? [];
  if (urls.length === 0) throw new Error('light sync requires at least one configured note indexer URL');
  const store = options.store ?? defaultLightCheckpointStore();
  const scope: LightCheckpointScope = { chainId: connection.config.chain.id, pool: connection.config.contracts.pool, seed: keys.seed };
  const initialHead = await connection.client.getBlock();
  let stored: ReturnType<typeof restoreCheckpoint> | undefined;
  const saved = await store.load(scope);
  if (saved) {
    try {
      const candidate = restoreCheckpoint(saved, keys);
      if (candidate.blockNumber <= initialHead.number
        && (await connection.client.getBlock({ blockNumber: candidate.blockNumber })).hash?.toLowerCase() === candidate.blockHash.toLowerCase()) stored = candidate;
      else await store.delete(scope);
    } catch {
      await store.delete(scope);
    }
  }
  const errors: unknown[] = [];
  for (const url of urls) {
    try { return await syncFromIndexer(url, connection, keys, initialHead, onProgress, options, store, scope, stored); }
    catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, 'all configured note indexers failed');
}
