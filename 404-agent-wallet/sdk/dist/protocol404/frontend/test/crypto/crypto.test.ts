import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IncrementalMerkleTree, decodeNotePlaintext, decodePrivateAddress, decryptIncomingNote,
  decryptOutgoingNote,
  deriveAddress, deriveKeys, deriveNoteSecrets, encodeNotePlaintext, encodePrivateAddress,
  encryptNote, encryptOutgoingNote, noteCommitment, poseidonHash2, createNote,
  assertAsset, noteInner, poseidonHash3, DOMAINS,
} from '../../src/crypto/index.ts';

test('Poseidon2 and HKDF key derivation match extracted reference vectors', () => {
  // Values produced by the pure reference functions MS/zS from index-CVtw0LZh.js:18521-18548.
  assert.equal(poseidonHash2(0n, 0n), 5151499478991301833156025595048985053689893395646836724335623777508747990769n);
  const keys = deriveKeys(new Uint8Array(32));
  assert.equal(keys.sk, 12104179090261302203697977029222324048677785920373252003700695944855168601672n);
  assert.equal(keys.nk, 2096542373376900438641459450280137726324877039798837213245429566274130745845n);
  assert.equal(keys.ivk, 3842455206691565514222388670901179577204946904775297020633952243374149991019n);
  assert.equal(keys.spendPub, 9124245450946951271375575912317922546735824176888399649186875668956587281158n);
  assert.equal(keys.nkc, 2700014429024698879206324559521969722207092163073705320689815331532189259401n);
});

test('address, note plaintext and recipient encryption round-trip byte-for-byte', () => {
  const keys = deriveKeys(new Uint8Array(32));
  const address = deriveAddress(keys, new Uint8Array(11));
  const encoded = encodePrivateAddress(address);
  assert.equal(encoded, '4041qyqqqqqqqqqqqqqqqqq8vxyy6v3xe3wslefp2cktkd8tcmd8r3ue9t95neyy9jp3ulgsj8qqxzdsug9v64pqkaj3zasaxl7vjngh9vegtkjmt8fqpum8xehm9d0qffwymz9vva');
  assert.equal(decodePrivateAddress(encoded).owner, address.owner);

  const note = createNote(address, 123n, { rseed: new Uint8Array(32).fill(1), memo: Uint8Array.of(1, 2, 3) });
  assert.deepEqual(decodeNotePlaintext(encodeNotePlaintext(note)), note);
  const commitment = noteCommitment(note, address.owner, deriveNoteSecrets(note.rseed).rcm);
  assert.equal(commitment, 14844902556060356669762228586974558140750356858117370842762048081656071406940n);
  const context = { chainId: 196n, pool: new Uint8Array(20).fill(2) };
  const ciphertext = encryptNote(note, address, commitment, context);
  assert.equal(ciphertext.length, 175);
  assert.deepEqual(decryptIncomingNote(ciphertext, commitment, keys, context), note);
  assert.equal(decryptIncomingNote(ciphertext, commitment + 1n, keys, context), null);
  const outgoing = encryptOutgoingNote(note, address, commitment, keys.ovk, context);
  assert.deepEqual(decryptOutgoingNote(outgoing, commitment, keys, context), note);
});

test('recipient decryption remains compatible with an actual version 2 ciphertext', () => {
  const keys = deriveKeys(new Uint8Array(32));
  const address = deriveAddress(keys, new Uint8Array(11));
  const note = createNote(address, 123n, { rseed: new Uint8Array(32).fill(1), memo: Uint8Array.of(1, 2, 3) });
  const commitment = noteCommitment(note, address.owner, deriveNoteSecrets(note.rseed).rcm);
  const ciphertext = Uint8Array.from(Buffer.from(
    '3ef161797ef270f8855dc0d6a1a70060a700a74e1e71553fa356b72beae27a38d846a2fc3ee5139768cd12fe9b0025179d2684fe749a4a8d3d9168d006a1519cf069ecc758cb48cbd35bdf0c12361590983d31763c52efef55686610a7fd69269de6684a88858fadc91186060276c11a117833caca4b7de3a10481e39cbc1c4fb4dae7d8e63de43f7700698eccd7dd397c359eb143160e9278ff4b3b3f8475dae760d0a8aced5bcbf6c86b44',
    'hex',
  ));
  assert.equal(ciphertext.length, 172);
  assert.deepEqual(decryptIncomingNote(ciphertext, commitment, keys,
    { chainId: 196n, pool: new Uint8Array(20).fill(2) }), note);
});

test('v1 asset identifiers round-trip in the u32 wire slot', () => {
  const keys = deriveKeys(new Uint8Array(32));
  const address = deriveAddress(keys, new Uint8Array(11));
  const context = { chainId: 196n, pool: new Uint8Array(20).fill(2) };
  for (const asset of [0, 1] as const) {
    const note = createNote(address, 123n, { asset, rseed: new Uint8Array(32).fill(1) });
    const plaintext = encodeNotePlaintext(note);
    assert.equal(plaintext.length, 127);
    assert.equal(plaintext[0], 3);
    assert.deepEqual([...plaintext.slice(1, 5)], [asset >>> 24, asset >>> 16 & 0xff, asset >>> 8 & 0xff, asset & 0xff]);
    assert.deepEqual(decodeNotePlaintext(plaintext), note);
    const { rcm } = deriveNoteSecrets(note.rseed);
    const commitment = noteCommitment(note, address.owner, rcm);
    assert.equal(commitment, poseidonHash3(DOMAINS.NOTE, (BigInt(asset) << 64n) + 123n, noteInner(address.owner, 0n, rcm)));
    const ciphertext = encryptNote(note, address, commitment, context);
    assert.equal(ciphertext.length, 175);
    assert.deepEqual(decryptIncomingNote(ciphertext, commitment, keys, context), note);
  }
});

test('v1 asset identifiers reject unregistered values', () => {
  for (const asset of [-1, 1.5, 2, 255, 0xffff_ffff]) {
    assert.throws(() => assertAsset(asset), /unknown asset/);
  }
});

test('private addresses accept only 4041 with a valid checksum', () => {
  const oldBcashAddress = 'bcash1qyqqqqqqqqqqqqqqqqq8vxyy6v3xe3wslefp2cktkd8tcmd8r3ue9t95neyy9jp3ulgsj8qqxzdsug9v64pqkaj3zasaxl7vjngh9vegtkjmt8fqpum8xehm9d0qffwy86628d';
  const oldSxAddress = 'sx1qyqqqqqqqqqqqqqqqqq8vxyy6v3xe3wslefp2cktkd8tcmd8r3ue9t95neyy9jp3ulgsj8qqxzdsug9v64pqkaj3zasaxl7vjngh9vegtkjmt8fqpum8xehm9d0qffwyffgv6v';
  const encoded = encodePrivateAddress(deriveAddress(deriveKeys(new Uint8Array(32)), new Uint8Array(11)));
  const badChecksum = `${encoded.slice(0, -1)}${encoded.endsWith('q') ? 'p' : 'q'}`;
  assert.throws(() => decodePrivateAddress(oldBcashAddress), /prefix/);
  assert.throws(() => decodePrivateAddress(oldSxAddress), /prefix/);
  assert.throws(() => decodePrivateAddress(badChecksum), /checksum/i);
});

test('incremental Merkle root and paths update after sparse writes', () => {
  const tree = new IncrementalMerkleTree();
  assert.equal(tree.root(), 5133978852121333258945738158023312408330097040934952294511033236283137218189n);
  tree.insertPair(1n, 2n);
  const firstRoot = tree.root();
  assert.equal(tree.path(0)[0], 2n);
  tree.setLeaf(1, 3n);
  assert.notEqual(tree.root(), firstRoot);
  assert.equal(tree.path(0)[0], 3n);
});
