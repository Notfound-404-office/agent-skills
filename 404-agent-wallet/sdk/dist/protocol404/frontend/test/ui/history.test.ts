import assert from 'node:assert/strict';
import test from 'node:test';
import type { WalletHistoryResult } from '../../src/chain/history.ts';
import { createHistoryCoordinator, historyPage, walletHistoryRows, type WalletHistoryContext } from '../../src/ui/history.ts';

const result: WalletHistoryResult = {
  transactions: [{
    txHash: '0x1234567890abcdef', blockNumber: '11', timestamp: '100', status: 'observed', operation: 'send',
    noteFlow: { description: 'owned-note flow', token: { received: '30', spent: '100', net: '-70' }, native: { received: '0', spent: '0', net: '0' } },
    orderEvents: [{ type: 'OrderFilled', orderId: '7', marketAddress: '0x1' }],
  }],
  local: [{ id: 'local-1', createdAt: 101_000, status: 'submitted', intent: { kind: 'mint' }, txHash: '0xabcdef' }],
  total: 1, nextOffset: null,
  coverage: { complete: true, fromBlock: '1', toBlock: '11', headHash: '0xaa', orderMakerRange: { from: 0, to: 9999 }, note: 'complete' },
};

test('history rows label owned-note flow without guessing a transfer amount', () => {
  const rows = walletHistoryRows(result, 56, '404', 'BNB');
  assert.equal(rows[0]?.operation, 'Mint');
  assert.equal(rows[0]?.localOnly, true);
  assert.equal(rows[0]?.status, 'submitted');
  assert.equal(rows[0]?.txUrl, 'https://bscscan.com/tx/0xabcdef');
  assert.match(rows[0]?.flows[0] ?? '', /Unknown/);
  assert.equal(rows[1]?.operation, 'Private transfer');
  assert.deepEqual(rows[1]?.flows, ['Received 0.0000003 · Spent 0.000001 · Net -0.0000007 404']);
  assert.match(rows[1]?.summary ?? '', /#7 Fill order/);
  assert.equal(rows[1]?.txUrl, 'https://bscscan.com/tx/0x1234567890abcdef');
});

test('history pagination is local and clamps after result size changes', () => {
  const values = Array.from({ length: 45 }, (_, index) => index);
  assert.deepEqual(historyPage(values, 1).rows, values.slice(20, 40));
  const last = historyPage(values, 99);
  assert.equal(last.page, 2);
  assert.deepEqual(last.rows, values.slice(40));
  assert.deepEqual(historyPage([], 3), { rows: [], page: 0, pages: 1 });
});

function context(hash: `0x${string}`): WalletHistoryContext {
  return {
    connection: {} as WalletHistoryContext['connection'],
    session: { pendingTransactions: () => [] } as unknown as WalletHistoryContext['session'],
    snapshot: { head: { hash } } as WalletHistoryContext['snapshot'],
  };
}

test('history coordinator deduplicates one context and rejects stale results after clear or head change', async () => {
  let current: WalletHistoryContext | null = context('0xaa');
  let resolve!: (value: WalletHistoryResult) => void;
  let loads = 0;
  const applied: WalletHistoryResult[] = [];
  const controller = createHistoryCoordinator({
    getContext: () => current,
    load: () => { loads++; return new Promise(done => { resolve = done; }); },
    apply: value => applied.push(value), fail: () => assert.fail('unexpected failure'), reset: () => undefined,
  });
  const first = controller.refresh();
  const duplicate = controller.refresh();
  assert.equal(first, duplicate);
  assert.equal(loads, 1);
  current = { ...current!, snapshot: { head: { hash: '0xbb' } } as unknown as WalletHistoryContext['snapshot'] };
  resolve(result);
  await first;
  assert.equal(applied.length, 0);

  let resolveSecond!: (value: WalletHistoryResult) => void;
  const secondController = createHistoryCoordinator({
    getContext: () => current,
    load: () => new Promise(done => { resolveSecond = done; }),
    apply: value => applied.push(value), fail: () => assert.fail('unexpected failure'), reset: () => undefined,
  });
  const pending = secondController.refresh();
  secondController.clear();
  resolveSecond(result);
  await pending;
  assert.equal(applied.length, 0);
});
