import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryLightCheckpointStore, type LightCheckpoint } from '../../src/chain/light-store.ts';

const pool = '0x2222222222222222222222222222222222222222' as const;
const blockHash = `0x${'ab'.repeat(32)}` as const;
const checkpoint: LightCheckpoint = {
  version: 1,
  anchor: { blockNumber: '10', blockHash, timestamp: '20' },
  cursor: '7', fromBlock: '1',
  owned: [{
    leafIndex: 6, cm: '123456789', nf: '987654321', publicValue: false, asset: 0,
    d: `0x${'11'.repeat(11)}`, value: '42', lockUntil: '0', rseed: `0x${'22'.repeat(32)}`, memo: `0x${'33'.repeat(63)}`,
  }],
};

test('memory checkpoint records are encrypted and bound to wallet and deployment', async () => {
  const store = new MemoryLightCheckpointStore();
  const scope = { chainId: 56, pool, seed: new Uint8Array(32).fill(4) };
  await store.save(scope, checkpoint);

  const serializedEnvelope = JSON.stringify([...store.records.values()]);
  assert.equal(serializedEnvelope.includes('123456789'), false);
  assert.deepEqual(await store.load(scope), checkpoint);
  assert.equal(await store.load({ ...scope, seed: new Uint8Array(32).fill(5) }), null);
  assert.equal(await store.load({ ...scope, chainId: 1 }), null);
});

test('authenticated checkpoint corruption is rejected', async () => {
  const store = new MemoryLightCheckpointStore();
  const scope = { chainId: 56, pool, seed: new Uint8Array(32).fill(7) };
  await store.save(scope, checkpoint);
  const [id, envelope] = [...store.records.entries()][0]!;
  store.records.set(id, { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}00` as `0x${string}` });
  await assert.rejects(store.load(scope), /authentication failed/);
});
