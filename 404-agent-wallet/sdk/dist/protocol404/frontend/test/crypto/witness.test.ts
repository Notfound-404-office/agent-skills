import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BN254_FIELD_MODULUS, EMPTY_ROOTS, IncrementalMerkleTree, LightWitnessTree, buildHoldWitness,
  buildTransferWitness, createNote, deriveAddress, deriveKeys, deriveNoteSecrets, noteCommitment,
} from '../../src/crypto/index.ts';

const fixture = () => {
  const keys = deriveKeys(new Uint8Array(32));
  const to = deriveAddress(keys, new Uint8Array(11));
  const input = createNote(to, 50n, { rseed: new Uint8Array(32).fill(1), lockUntil: 7n });
  const cm = noteCommitment(input, to.owner, deriveNoteSecrets(input.rseed).rcm);
  const tree = new IncrementalMerkleTree();
  tree.insertSingle(cm);
  const output0 = { to, note: createNote(to, 40n, { rseed: new Uint8Array(32).fill(2) }) };
  const output1 = { to, note: createNote(to, 5n, { rseed: new Uint8Array(32).fill(3) }) };
  return { keys, to, input, tree, output0, output1 };
};

function abiNames(name: 'transfer' | 'hold'): string[] {
  const artifact = JSON.parse(readFileSync(new URL(`../../../circuits/${name}.json`, import.meta.url), 'utf8'));
  return artifact.abi.parameters.map((parameter: { name: string }) => parameter.name);
}

test('transfer witness matches artifact shape and extracted reference values', () => {
  const { keys, input, tree, output0, output1 } = fixture();
  const rng = (length: number) => new Uint8Array(length).fill(length === 11 ? 4 : 5);
  const witness = buildTransferWitness({
    keys, tree, inputs: [{ note: input, leafIndex: 0 }, null], outputs: [output0, output1],
    now: 100n, fee: 5n, publicOut: 0n, extHash: 9n, rng,
  });
  assert.deepEqual(Object.keys(witness.inputs), abiNames('transfer'));
  assert.equal(witness.pub.root, 7187272325244784327101816509504174227036625314972931645354726302477885417727n);
  assert.equal(witness.pub.nullifiers[0], 15154453373280221626191258229996730552302168745748242708046209433448998256673n);
  assert.equal(witness.inputs.in_path[0]?.length, 32);
  assert.equal(witness.inputs.in_value[1], '0');
  assert.equal(witness.inputs.out_value[0], '40');
});

test('hold witness preserves four slots, real membership and randomized dummy tags', () => {
  const { keys, input, tree } = fixture();
  let fill = 8;
  const rng = (length: number) => new Uint8Array(length).fill(fill++);
  const witness = buildHoldWitness({
    keys, tree, notes: [{ note: input, leafIndex: 0 }, null, null, null], threshold: 50n,
    minLock: 7n, campaignId: 12n, binding: 13n, rng,
  });
  assert.deepEqual(Object.keys(witness.inputs), abiNames('hold'));
  assert.equal(witness.pub.tags.length, 4);
  assert.equal(witness.inputs.value[0], '50');
  assert.deepEqual(witness.inputs.value.slice(1), ['0', '0', '0']);
  assert.equal(witness.inputs.path[0]?.length, 32);
  assert.notEqual(witness.pub.tags[1], witness.pub.tags[2]);
});

test('transfer witness accepts both deployed v1 assets', () => {
  const asset = 1 as const;
  const keys = deriveKeys(new Uint8Array(32));
  const to = deriveAddress(keys, new Uint8Array(11));
  const input = createNote(to, 50n, { asset, rseed: new Uint8Array(32).fill(1) });
  const tree = new IncrementalMerkleTree();
  tree.insertSingle(noteCommitment(input, to.owner, deriveNoteSecrets(input.rseed).rcm));
  const outputs = [
    { to, note: createNote(to, 40n, { asset, rseed: new Uint8Array(32).fill(2) }) },
    { to, note: createNote(to, 5n, { asset, rseed: new Uint8Array(32).fill(3) }) },
  ] as const;
  const witness = buildTransferWitness({
    keys, tree, asset, inputs: [{ note: input, leafIndex: 0 }, null], outputs,
    now: 100n, fee: 5n, extHash: 9n, rng: length => new Uint8Array(length).fill(4),
  });
  assert.equal(witness.pub.asset, asset);
  assert.equal(witness.inputs.asset, '1');
});

test('light tree produces the same transfer and hold witnesses as the full tree', () => {
  const { keys, input, tree, output0, output1 } = fixture();
  const light = new LightWitnessTree(tree.root());
  light.addWitness(0, tree.leaf(0), tree.path(0));
  const transferRequest = {
    keys, inputs: [{ note: input, leafIndex: 0 }, null] as const, outputs: [output0, output1] as const,
    now: 100n, fee: 5n, extHash: 9n, rng: (length: number) => new Uint8Array(length).fill(4),
  };
  assert.deepEqual(
    buildTransferWitness({ ...transferRequest, tree: light }),
    buildTransferWitness({ ...transferRequest, tree }),
  );

  const holdRequest = {
    keys, notes: [{ note: input, leafIndex: 0 }, null, null, null] as const,
    threshold: 50n, minLock: 7n, campaignId: 12n, binding: 13n,
    rng: (length: number) => new Uint8Array(length).fill(8),
  };
  assert.deepEqual(
    buildHoldWitness({ ...holdRequest, tree: light }),
    buildHoldWitness({ ...holdRequest, tree }),
  );
});

test('light tree rejects invalid and unknown witnesses without retaining mutable paths', () => {
  const { tree } = fixture();
  const root = tree.root();
  const commitment = tree.leaf(0);
  const path = tree.path(0);
  const light = new LightWitnessTree(root);

  assert.throws(() => light.addWitness(0, commitment, path.slice(1)), /32 siblings/);
  assert.throws(() => light.addWitness(0, commitment, [path[0]! + 1n, ...path.slice(1)]), /does not match root/);
  assert.throws(() => light.addWitness(-1, commitment, path), /leaf index/);
  assert.throws(() => light.addWitness(0.5, commitment, path), /leaf index/);
  assert.throws(() => light.addWitness(0x1_0000_0000, commitment, path), /leaf index/);
  assert.throws(() => new LightWitnessTree(BN254_FIELD_MODULUS), /root/);
  assert.throws(() => light.addWitness(0, BN254_FIELD_MODULUS, path), /leaf/);
  assert.throws(() => light.addWitness(0, commitment, [BN254_FIELD_MODULUS, ...path.slice(1)]), /path\[0\]/);
  assert.throws(() => light.leaf(0), /no witness/);
  assert.throws(() => light.path(0), /no witness/);

  const suppliedPath = path.slice();
  light.addWitness(0, commitment, suppliedPath);
  suppliedPath[0] = suppliedPath[0]! + 1n;
  const returnedPath = light.path(0);
  assert.equal(returnedPath[0], path[0]);
  (returnedPath as bigint[])[0] = returnedPath[0]! + 1n;
  assert.equal(light.path(0)[0], path[0]);
});

test('witness builders reject a tree that supplies an invalid membership path', () => {
  const { keys, input, tree, output0, output1 } = fixture();
  const badTree = {
    root: () => tree.root(),
    leaf: (index: number) => tree.leaf(index),
    path: (index: number) => [tree.path(index)[0]! + 1n, ...tree.path(index).slice(1)],
  };
  assert.throws(() => buildTransferWitness({
    keys, tree: badTree, inputs: [{ note: input, leafIndex: 0 }, null], outputs: [output0, output1],
    now: 100n, extHash: 9n, rng: length => new Uint8Array(length).fill(4),
  }), /does not match root/);
});

test('fixed empty root builds all-dummy witnesses without stored paths', () => {
  const keys = deriveKeys(new Uint8Array(32));
  const to = deriveAddress(keys, new Uint8Array(11));
  const tree = new LightWitnessTree(EMPTY_ROOTS[32]!);
  const outputs = [
    { to, note: createNote(to, 0n, { rseed: new Uint8Array(32).fill(2) }) },
    { to, note: createNote(to, 0n, { rseed: new Uint8Array(32).fill(3) }) },
  ] as const;
  const rng = (length: number) => new Uint8Array(length).fill(4);

  const transfer = buildTransferWitness({
    keys, tree, inputs: [null, null], outputs, now: 1n, extHash: 2n, rng,
  });
  assert.deepEqual(transfer.inputs.in_path, [Array(32).fill('0x' + '00'.repeat(32)), Array(32).fill('0x' + '00'.repeat(32))]);

  const hold = buildHoldWitness({
    keys, tree, notes: [null, null, null, null], threshold: 0n, minLock: 0n,
    campaignId: 3n, binding: 4n, rng,
  });
  assert.deepEqual(hold.inputs.path, Array.from({ length: 4 }, () => Array(32).fill('0x' + '00'.repeat(32))));
});
