import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, zeroAddress, zeroHash, type Address, type Hex, type WalletClient } from 'viem';
import { rawAbis } from '../../src/abi/index.ts';
import type { PoolConnection } from '../../src/chain/client.ts';
import { create404Config } from '../../src/config/index.ts';
import { describeAuthorization, parseAuthorization, serializeAuthorization, submitAuthorization } from '../../src/flows/portable.ts';

const addr = (byte: string) => `0x${byte.repeat(20)}` as Address;
function fixture() {
  const config = create404Config({ chainId: 56, rpcUrl: 'http://unused', deployBlock: 0n,
    deployment: { '404Pool': addr('ab'), '404Token': addr('02'), '404Hasher': addr('03'),
      '404Market': addr('05'), '404Mint': addr('06'), '404Bundle': addr('07'), '404TransferVerifier': addr('08'), '404HoldVerifier': addr('09') } });
  const calls: unknown[] = [];
  const estimates: unknown[] = [];
  const connection = { config, client: {
    call: async (value: unknown) => { calls.push(value); return { data: '0x' }; },
    estimateGas: async (value: unknown) => { estimates.push(value); return 100_000n; },
    readContract: async () => { throw new Error('non-Mint must not read NFT eligibility'); },
  } } as unknown as PoolConnection;
  const tx = { proof: `0x${'ab'.repeat(8000)}`, pub: {
    root: '1', nullifiers: ['2', '3'], commitments: ['4', '5'], nowTs: '100', asset: '1', publicOut: '7', fee: '0',
  }, ext: { recipient: addr('10'), relayer: zeroAddress, caller: zeroAddress, data: zeroHash,
    ciphertexts: [`0x${'00'.repeat(175)}`, `0x${'00'.repeat(175)}`] } };
  return { connection, tx, calls, estimates };
}

test('the same authorization is submitted by arbitrary wallets without private keys or relay calls', async () => {
  const { connection, tx, calls, estimates } = fixture();
  const packet = serializeAuthorization(connection, '/relay', tx);
  const sent: any[] = [];
  const stages: string[][] = [];
  for (const account of [addr('21'), addr('22')]) {
    let durable = false;
    const observedStages: string[] = [];
    const wallet = { getAddresses: async () => [account], getChainId: async () => 56,
      sendTransaction: async (value: unknown) => { assert(durable); sent.push(value); return `0x${'12'.repeat(32)}`; },
    } as unknown as WalletClient;
    await submitAuthorization(connection, wallet, packet, { gasPriceWei: 50_000_000n,
      onStage: stage => observedStages.push(stage), beforeSend: async () => { durable = true; } });
    stages.push(observedStages);
  }
  assert.equal(calls.length, 0);
  assert.equal(estimates.length, 2);
  assert.deepEqual(stages, [['estimating', 'wallet'], ['estimating', 'wallet']]);
  assert.notEqual(sent[0].account, sent[1].account);
  assert.equal(sent[0].data, sent[1].data);
  assert.equal((estimates[0] as { data: Hex }).data, sent[0].data);
  assert.equal(sent[0].to, connection.config.contracts.pool);
  assert.equal(sent[0].value, 0n);
  assert.equal(sent[0].nonce, undefined);
  const call = decodeFunctionData({ abi: rawAbis.pool, data: sent[0].data });
  assert.equal(call.functionName, 'transact');
});

test('mandatory estimation failure or a low manual gas budget never reaches durable state or wallet send', async () => {
  const { connection, tx, calls, estimates } = fixture();
  const packet = serializeAuthorization(connection, '/relay', tx);
  let durable = 0;
  let sent = 0;
  const wallet = { getAddresses: async () => [addr('21')], getChainId: async () => 56,
    sendTransaction: async () => { sent++; return `0x${'12'.repeat(32)}` as Hex; },
  } as unknown as WalletClient;

  (connection.client.estimateGas as unknown as (value: unknown) => Promise<bigint>) = async value => {
    estimates.push(value); throw new Error('proof rejected');
  };
  await assert.rejects(submitAuthorization(connection, wallet, packet, {
    gasPriceWei: 50_000_000n, gasLimit: 200_000n, beforeSend: async () => { durable++; },
  }), /proof rejected/);
  assert.equal(sent, 0);
  assert.equal(durable, 0);
  assert.equal(calls.length, 0);

  (connection.client.estimateGas as unknown as (value: unknown) => Promise<bigint>) = async value => {
    estimates.push(value); return 100_000n;
  };
  await assert.rejects(submitAuthorization(connection, wallet, packet, {
    gasPriceWei: 50_000_000n, gasLimit: 99_999n, beforeSend: async () => { durable++; },
  }), /Gas budget is too low/);
  assert.equal(sent, 0);
  assert.equal(durable, 0);
  assert.equal(calls.length, 0);
  assert.equal(estimates.length, 2);
});

test('import rejects foreign chain/pool, arbitrary transactions, nonzero fees and submitting-wallet bindings', () => {
  const { connection, tx } = fixture();
  const original = JSON.parse(serializeAuthorization(connection, '/relay', tx));
  for (const change of [{ chainId: 11155111 }, { pool: addr('ff') }, { value: '1' }, { to: addr('ff') }, { path: '/bundle' }]) {
    assert.throws(() => parseAuthorization(connection, JSON.stringify({ ...original, ...change })));
  }
  assert.throws(() => serializeAuthorization(connection, '/relay', { ...tx, pub: { ...tx.pub, fee: '1' } }), /zero relayer fee/);
  assert.throws(() => serializeAuthorization(connection, '/relay', { ...tx, ext: { ...tx.ext, relayer: addr('21') } }), /bound/);
  assert.throws(() => parseAuthorization(connection, 'x'.repeat(262_145)), /too large/);
});

test('export strips unknown secret fields and duplicate identity follows exact calldata, not JSON casing', () => {
  const { connection, tx } = fixture();
  const packet = serializeAuthorization(connection, '/relay', { ...tx, seed: 'never-export-this', walletNonce: 123 });
  assert.doesNotMatch(packet, /never-export-this|walletNonce|seed/);
  const variant = JSON.parse(packet);
  variant.body.proof = `0x${'AB'.repeat(8000)}`;
  assert.equal(describeAuthorization(connection, packet).id, describeAuthorization(connection, JSON.stringify(variant)).id);
});
