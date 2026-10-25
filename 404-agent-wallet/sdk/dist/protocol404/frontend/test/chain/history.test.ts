import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolConnection } from '../../src/chain/client.ts';
import { rawAbis } from '../../src/abi/index.ts';
import { readWalletHistory } from '../../src/chain/history.ts';
import type { PrivateSnapshot } from '../../src/chain/sync.ts';

const address = (digit: string) => `0x${digit.repeat(40)}` as const;
const hash = (digit: string) => `0x${digit.repeat(64)}` as const;

test('served ABIs expose the u32 asset deployment', () => {
  const pool = rawAbis.pool as readonly any[];
  const shielded = pool.find(item => item.type === 'event' && item.name === 'Shielded');
  assert.equal(shielded.inputs.find((input: any) => input.name === 'asset').type, 'uint32');
  assert.equal(pool.find(item => item.type === 'function' && item.name === 'ASSET_ID_BITS').outputs[0].type, 'uint8');
  const native = pool.find(item => item.type === 'function' && item.name === 'NATIVE');
  assert.equal(native.outputs[0].type, 'uint32');
});

test('assembles the shared history engine from an existing snapshot and configured ABIs', async () => {
  const eventSets: string[][] = [];
  const connection = {
    client: {
      async getLogs(request: { events: Array<{ name?: string }> }) {
        eventSets.push(request.events.map(event => event.name ?? ''));
        return [];
      },
      async getBlock() { return { hash: hash('a'), timestamp: 100n }; },
    },
    config: {
      deployBlock: 10n,
      marketVersion: 2,
      contracts: { pool: address('1'), market: address('2') },
    },
  } as unknown as PoolConnection;
  const snapshot = {
    owned: [], spent: new Set(), head: { number: 10n, hash: hash('a'), timestamp: 100n },
  } as unknown as PrivateSnapshot;

  const result = await readWalletHistory(connection, snapshot, [], () => address('3'));

  assert.equal(result.total, 0);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.headHash, hash('a'));
  assert.ok(eventSets[0]?.includes('NoteAdded'));
  assert.ok(eventSets[1]?.includes('OrderPlaced'));
  assert.ok(eventSets[1]?.includes('OrderFilled'));
});
