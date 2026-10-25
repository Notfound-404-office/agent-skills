import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address } from 'viem';
import type { MarketOrder } from '../../src/chain/trading.ts';
import { Protocol404Session } from '../../src/flows/session.ts';
import { recoverOrderKeys } from '../../src/ui/trading.ts';

function mockSession(scope = 0, reserved: readonly number[] = []) {
  let calls = 0;
  const maker = (index: number): Address => `0x${(BigInt(scope) * 100_000n + BigInt(index)).toString(16).padStart(40, '0')}`;
  const session = {
    orderMaker(index: number) { calls++; return maker(index); },
    pendingTransactions: () => reserved.map(index => ({
      status: 'prepared', intent: { kind: 'place' }, body: { place: { maker: maker(index) } },
    })),
  } as unknown as Protocol404Session;
  return { session, maker, calls: () => calls };
}

function order(index: number, maker: Address): MarketOrder {
  return { id: BigInt(index), maker, sellAsset: 0, open: false, releases: 0,
    sellAmount: 1n, buyAmount: 1n, remaining: 0n, proceeds: 0n };
}

test('restore matches closed orders across the full 10,000-key range without stopping at gaps', async () => {
  const wallet = mockSession();
  const indices = [0, 255, 256, 4_096, 9_999];
  const orders = indices.map(index => order(index, wallet.maker(index)));
  orders.push(order(10_000, wallet.maker(10_000)));
  const recovered = await recoverOrderKeys(wallet.session, orders);
  assert.deepEqual([...recovered.byOrder], indices.map(index => [BigInt(index), index]));
  assert.equal(recovered.next, 1);
  assert.equal(wallet.calls(), 10_000);
});

test('batched recovery yields, shares derivation work and refreshes reservations without mixing wallets', async () => {
  const reserved = [0];
  const wallet = mockSession(1, reserved);
  let yielded = false;
  const timer = setTimeout(() => { yielded = true; reserved.push(1); }, 0);
  try {
    const [first, concurrent] = await Promise.all([
      recoverOrderKeys(wallet.session, []), recoverOrderKeys(wallet.session, []),
    ]);
    assert.equal(yielded, true);
    assert.equal(first.next, 2);
    assert.equal(concurrent.next, 2);
    assert.equal(wallet.calls(), 10_000);
    const refreshed = await recoverOrderKeys(wallet.session, [order(2, wallet.maker(2))]);
    assert.equal(refreshed.next, 3);
    assert.equal(refreshed.byOrder.get(2n), 2);
    assert.equal(wallet.calls(), 10_000);
    const other = mockSession(2);
    assert.equal((await recoverOrderKeys(other.session, [order(1, wallet.maker(1))])).byOrder.size, 0);
    assert.equal(other.calls(), 10_000);
  } finally { clearTimeout(timer); }
});

test('using all recovery keys blocks allocation without hiding existing history', async () => {
  const wallet = mockSession();
  const orders = Array.from({ length: 10_000 }, (_, index) => order(index, wallet.maker(index)));
  const recovered = await recoverOrderKeys(wallet.session, orders);
  assert.equal(recovered.next, null);
  assert.equal(recovered.byOrder.size, 10_000);
  assert.equal(recovered.byOrder.get(9_999n), 9_999);
});

test('restoring the same seed reproduces a high-index maker with unchanged network and market domains', () => {
  const restored = (market = '0x1111111111111111111111111111111111111111') => Object.assign(
    Object.create(Protocol404Session.prototype), {
      keys: { seed: new Uint8Array(32).fill(7) },
      connection: { config: { chain: { id: 11155111 }, contracts: { market } } },
    },
  ) as Protocol404Session;
  assert.equal(restored().orderMaker(9_999), restored().orderMaker(9_999));
  assert.notEqual(restored().orderMaker(255), restored().orderMaker(9_999));
  assert.notEqual(restored().orderMaker(9_999), restored('0x2222222222222222222222222222222222222222').orderMaker(9_999));
});
