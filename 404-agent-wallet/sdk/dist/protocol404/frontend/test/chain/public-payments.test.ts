import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash, Hex, WalletClient } from 'viem';
import { publicWriteFees, depositNote, sweepProceeds, type PoolConnection } from '../../src/chain/client.ts';
import type { ConnectedWallet } from '../../src/wallet/providers.ts';

const payerAddress = '0x1111111111111111111111111111111111111111' as Address;
const tokenAddress = '0x2222222222222222222222222222222222222222' as Address;
const poolAddress = '0x3333333333333333333333333333333333333333' as Address;
const treasuryAddress = '0x5555555555555555555555555555555555555555' as Address;
const hashes = [
  `0x${'01'.repeat(32)}` as Hash,
  `0x${'02'.repeat(32)}` as Hash,
];

function fixture(invalidateAfterApproval: boolean) {
  let current = true;
  const writes: string[] = [];
  const wallet = {
    account: { address: payerAddress },
    getAddresses: async () => [payerAddress],
    getChainId: async () => 97,
    writeContract: async (request: { functionName: string }) => {
      writes.push(request.functionName);
      return hashes[writes.length - 1]!;
    },
  } as unknown as WalletClient;
  const config = {
    chain: { id: 97, nativeCurrency: { symbol: 'BNB' }, rpcUrls: { default: { http: ['http://unused'] } } },
    contracts: { token: tokenAddress, pool: poolAddress },
  };
  const client = {
    readContract: async () => payerAddress,
    simulateContract: async (parameters: object) => ({ request: parameters }),
    estimateContractGas: async () => 1n,
    waitForTransactionReceipt: async ({ hash }: { hash: Hash }) => {
      if (invalidateAfterApproval && hash === hashes[0]) current = false;
      return { status: 'success' };
    },
  };
  const connection = {
    client,
    token: { read: { allowance: async () => 0n } },
    config,
  } as unknown as PoolConnection;
  const payer: ConnectedWallet = { address: payerAddress, label: 'test', client: wallet, injected: false };
  const assertCurrent = () => { if (!current) throw new Error('Payment context changed; review again'); };
  return { connection, wallet, payer, writes, assertCurrent };
}

function sweepFixture(changeAfterSimulation?: 'account' | 'chain', proceeds = 10n) {
  let addresses: readonly Address[] = [tokenAddress, payerAddress];
  let chainId = 97;
  const writes: Array<{ functionName: string; account: Address }> = [];
  const wallet = {
    account: { address: payerAddress },
    getAddresses: async () => addresses,
    getChainId: async () => chainId,
    writeContract: async (request: { functionName: string; account: Address }) => {
      writes.push({ functionName: request.functionName, account: request.account });
      return hashes[0];
    },
  } as unknown as WalletClient;
  const config = {
    chain: { id: 97, nativeCurrency: { symbol: 'BNB' }, rpcUrls: { default: { http: ['http://unused'] } } },
    contracts: { token: tokenAddress, pool: poolAddress },
  };
  const connection = {
    config,
    pool: { read: { treasury: async () => treasuryAddress, mintProceeds: async () => proceeds } },
    client: {
      estimateContractGas: async () => 100n,
      simulateContract: async (parameters: object) => {
        if (changeAfterSimulation === 'account') addresses = [tokenAddress];
        if (changeAfterSimulation === 'chain') chainId = 56;
        return { request: parameters };
      },
      waitForTransactionReceipt: async () => ({ status: 'success', treasury: treasuryAddress }),
    },
  } as unknown as PoolConnection;
  return { connection, wallet, writes };
}

for (const invalidate of [true, false]) {
  test(`deposit ${invalidate ? 'stops' : 'continues'} after token approval when payment context ${invalidate ? 'changes' : 'stays current'}`, async () => {
    const { connection, wallet, writes, assertCurrent } = fixture(invalidate);
    const action = depositNote(connection, wallet, 0, 10n, 20n, '0x12' as Hex, assertCurrent);
    if (invalidate) await assert.rejects(action, /changed/);
    else await action;
    assert.deepEqual(writes, invalidate ? ['approve'] : ['approve', 'shield']);
  });

}

test('sweep uses the reviewed payer and never writes after stale wallet state or with zero proceeds', async t => {
  await t.test('success keeps caller separate from the fixed treasury', async () => {
    const { connection, wallet, writes } = sweepFixture();
    const receipt = await sweepProceeds(connection, wallet);
    assert.deepEqual(writes, [{ functionName: 'sweep', account: payerAddress }]);
    assert.equal((receipt as unknown as { treasury: Address }).treasury, treasuryAddress);
  });

  for (const changed of ['account', 'chain'] as const) {
    await t.test(`${changed} change blocks the write`, async () => {
      const { connection, wallet, writes } = sweepFixture(changed);
      await assert.rejects(sweepProceeds(connection, wallet), /changed|configured network/);
      assert.deepEqual(writes, []);
    });
  }

  await t.test('stale UI callback blocks the write', async () => {
    const { connection, wallet, writes } = sweepFixture();
    await assert.rejects(sweepProceeds(connection, wallet, () => { throw new Error('Payment context changed; review again'); }), /changed/);
    assert.deepEqual(writes, []);
  });

  await t.test('zero proceeds blocks simulation and write', async () => {
    const { connection, wallet, writes } = sweepFixture(undefined, 0n);
    await assert.rejects(sweepProceeds(connection, wallet), /No mint proceeds/);
    assert.deepEqual(writes, []);
  });
});

test('public payments preserve local signing rather than requesting eth_sendTransaction', async () => {
  const { connection, wallet, assertCurrent } = fixture(false);
  const signer = { address: payerAddress, type: 'local' } as const;
  (wallet as any).account = signer;
  (connection.client as any).estimateContractGas = async () => 100n;
  let writes = 0;
  (wallet as any).writeContract = async (request: any) => {
    assert.equal(request.account, signer);
    assert.equal(request.gas, 120n);
    writes++;
    return hashes[0];
  };
  await depositNote(connection, wallet, 0, 10n, 20n, '0x12', assertCurrent);
  assert.equal(writes, 2);
});

test('Sepolia uses the approved higher fees without changing BSC fees', async () => {
  const { connection } = fixture(false);
  assert.deepEqual(await publicWriteFees(connection), {});
  (connection.config.chain as any).id = 11155111;
  (connection.client as any).estimateFeesPerGas = async () => ({ maxFeePerGas: 54n, maxPriorityFeePerGas: 2n });
  assert.deepEqual(await publicWriteFees(connection), { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  (connection.client as any).estimateFeesPerGas = async () => ({ maxFeePerGas: 8_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n });
  assert.deepEqual(await publicWriteFees(connection), { maxFeePerGas: 8_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n });
});
