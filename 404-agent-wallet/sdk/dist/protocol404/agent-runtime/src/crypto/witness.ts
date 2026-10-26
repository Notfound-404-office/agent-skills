import { deriveAddress, addressOwner, type PrivateAddress } from './address.ts';
import { assertU64, bytesToBigInt, fieldToHex } from './bytes.ts';
import { DOMAINS, deriveKeys, type KeyMaterial } from './keys.ts';
import {
  assertAsset, createNote, deriveNoteSecrets, noteCommitment, noteLocation, noteNullifier,
  type Asset, type Note,
} from './note.ts';
import { poseidonHash3, poseidonHash4 } from './poseidon.ts';
import { assertNoteMembership, type NoteWitnessTree } from './witness-tree.ts';

export type RandomBytes = (length: number) => Uint8Array;
export type OwnedNote = Readonly<{ note: Note; leafIndex: number }>;
export type NoteOutput = Readonly<{ to: PrivateAddress; note: Note }>;

type InputNoteWitness = Readonly<{
  value: bigint; d: bigint; lock: bigint; rcm: bigint; index: bigint; path: readonly bigint[]; cm: bigint;
}>;

const ZERO_PATH = Object.freeze(Array<bigint>(32).fill(0n));

function secureRandom(length: number): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('crypto.getRandomValues must be defined');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function reduceRandomField(bytes: Uint8Array): bigint {
  if (bytes.length !== 64) throw new RangeError('wide reduction needs 64 bytes');
  const value = bytesToBigInt(bytes) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  if (value === 0n) throw new RangeError('zero scalar');
  return value;
}

const decimal = (value: bigint): string => value.toString();

/** @orig index-CVtw0LZh.js:19578 Qw Expand an owned note into its Merkle membership witness. */
export function ownedNoteWitness(keys: KeyMaterial, tree: NoteWitnessTree, owned: OwnedNote): InputNoteWitness {
  const { note, leafIndex } = owned;
  const { rcm } = deriveNoteSecrets(note.rseed);
  const cm = noteCommitment(note, addressOwner(keys.spendPub, keys.nkc, note.d), rcm);
  if (tree.leaf(leafIndex) !== cm) throw new Error(`leaf ${leafIndex} does not hold this note`);
  const path = tree.path(leafIndex);
  assertNoteMembership(tree.root(), leafIndex, cm, path);
  return {
    value: note.value,
    d: bytesToBigInt(note.d),
    lock: note.lockUntil,
    rcm,
    index: BigInt(leafIndex),
    path,
    cm,
  };
}

/** @orig index-CVtw0LZh.js:19595 $w Compute an output note commitment from its recipient owner. */
export function outputCommitment(output: NoteOutput): bigint {
  return noteCommitment(output.note, output.to.owner, deriveNoteSecrets(output.note.rseed).rcm);
}

/** @orig index-CVtw0LZh.js:19599 eT Create a zero-value output with unrelated random keys. */
export function createDummyOutput(rng: RandomBytes = secureRandom, asset: Asset = 0): NoteOutput {
  const to = deriveAddress(deriveKeys(rng(32)), rng(11));
  return { to, note: createNote(to, 0n, { asset, rseed: rng(32) }) };
}

export type TransferWitnessRequest = Readonly<{
  keys: KeyMaterial;
  tree: NoteWitnessTree;
  asset?: Asset;
  publicOut?: bigint;
  fee?: bigint;
  now: bigint;
  extHash: bigint;
  inputs: readonly [OwnedNote | null, OwnedNote | null];
  outputs: readonly [NoteOutput, NoteOutput];
  rng?: RandomBytes;
}>;

/** @orig index-CVtw0LZh.js:19610 tT Build the exact transfer circuit public values and Noir input object. */
export function buildTransferWitness(request: TransferWitnessRequest) {
  const { keys, tree } = request;
  const rng = request.rng ?? secureRandom;
  const asset = assertAsset(request.asset ?? 0);
  const publicOut = assertU64(request.publicOut ?? 0n, 'publicOut');
  const fee = assertU64(request.fee ?? 0n, 'fee');
  for (const input of request.inputs) {
    if (input && input.note.asset !== asset) throw new Error('an input holds another asset');
  }
  for (const output of request.outputs) {
    if (output.note.asset !== asset) throw new Error('an output holds another asset');
  }

  const inputWitnesses = request.inputs.map((owned): InputNoteWitness => {
    if (owned) return ownedNoteWitness(keys, tree, owned);
    const diversifier = rng(11);
    const rcm = reduceRandomField(rng(64));
    const cm = noteCommitment(
      { asset, d: diversifier, value: 0n, lockUntil: 0n, rseed: new Uint8Array(32), memo: new Uint8Array(63) },
      addressOwner(keys.spendPub, keys.nkc, diversifier), rcm,
    );
    return { value: 0n, d: bytesToBigInt(diversifier), lock: 0n, rcm, index: 0n, path: ZERO_PATH, cm };
  });
  const nullifiers = inputWitnesses.map(input => noteNullifier(keys.nk, noteLocation(input.cm, input.index)));
  const outputs = request.outputs.map(output => ({ output, rcm: deriveNoteSecrets(output.note.rseed).rcm, cm: outputCommitment(output) }));
  const pub = {
    root: tree.root(),
    nullifiers: [nullifiers[0]!, nullifiers[1]!] as const,
    commitments: [outputs[0]!.cm, outputs[1]!.cm] as const,
    now: assertU64(request.now, 'now'),
    asset,
    publicOut,
    fee,
    extHash: request.extHash,
  };
  return {
    pub,
    inputs: {
      root: fieldToHex(pub.root),
      nullifiers: pub.nullifiers.map(fieldToHex),
      commitments: pub.commitments.map(fieldToHex),
      now: decimal(pub.now),
      asset: decimal(BigInt(asset)),
      public_out: decimal(publicOut),
      fee: decimal(fee),
      ext_hash: fieldToHex(pub.extHash),
      sk: fieldToHex(keys.sk),
      nk: fieldToHex(keys.nk),
      in_value: inputWitnesses.map(input => decimal(input.value)),
      in_d: inputWitnesses.map(input => fieldToHex(input.d)),
      in_lock: inputWitnesses.map(input => decimal(input.lock)),
      in_rcm: inputWitnesses.map(input => fieldToHex(input.rcm)),
      in_index: inputWitnesses.map(input => decimal(input.index)),
      in_path: inputWitnesses.map(input => input.path.map(fieldToHex)),
      out_value: outputs.map(output => decimal(output.output.note.value)),
      out_owner: outputs.map(output => fieldToHex(output.output.to.owner)),
      out_lock: outputs.map(output => decimal(output.output.note.lockUntil)),
      out_rcm: outputs.map(output => fieldToHex(output.rcm)),
    },
  };
}

export type HoldWitnessRequest = Readonly<{
  keys: KeyMaterial;
  tree: NoteWitnessTree;
  notes: readonly [OwnedNote | null, OwnedNote | null, OwnedNote | null, OwnedNote | null];
  threshold: bigint;
  minLock: bigint;
  campaignId: bigint;
  binding: bigint;
  rng?: RandomBytes;
}>;

/** @orig index-CVtw0LZh.js:19685 nT Build the exact four-slot holding circuit public values and Noir input object. */
export function buildHoldWitness(request: HoldWitnessRequest) {
  if (request.notes.length !== 4) throw new RangeError('hold takes exactly 4 slots');
  const { keys, tree } = request;
  const rng = request.rng ?? secureRandom;
  const notes = request.notes.map(owned => {
    if (owned) {
      if (owned.note.asset !== 0) throw new Error('a holding proof counts protocol-token notes only');
      const input = ownedNoteWitness(keys, tree, owned);
      return {
        ...input,
        r: 0n,
        tag: poseidonHash4(DOMAINS.TAG, keys.nk, noteLocation(input.cm, input.index), request.campaignId),
      };
    }
    const r = reduceRandomField(rng(64));
    return {
      value: 0n, d: 0n, lock: 0n, rcm: 0n, index: 0n, path: ZERO_PATH, r,
      tag: poseidonHash3(DOMAINS.TAG_DUMMY, r, request.campaignId),
    };
  });
  const pub = {
    root: tree.root(),
    threshold: assertU64(request.threshold, 'threshold'),
    minLock: assertU64(request.minLock, 'minLock'),
    campaignId: request.campaignId,
    binding: request.binding,
    tags: notes.map(note => note.tag),
  };
  return {
    pub,
    inputs: {
      root: fieldToHex(pub.root),
      threshold: decimal(pub.threshold),
      min_lock: decimal(pub.minLock),
      campaign_id: fieldToHex(pub.campaignId),
      binding: fieldToHex(pub.binding),
      tags: pub.tags.map(fieldToHex),
      sk: fieldToHex(keys.sk),
      nk: fieldToHex(keys.nk),
      value: notes.map(note => decimal(note.value)),
      d: notes.map(note => fieldToHex(note.d)),
      lock: notes.map(note => decimal(note.lock)),
      rcm: notes.map(note => fieldToHex(note.rcm)),
      index: notes.map(note => decimal(note.index)),
      path: notes.map(note => note.path.map(fieldToHex)),
      dummy_r: notes.map(note => fieldToHex(note.r)),
    },
  };
}
