import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionResult, toFunctionSelector, type Address, type Hex } from 'viem';
import { rawAbis } from '../../src/abi/index.ts';
import { openPool } from '../../src/chain/client.ts';
import { create404Config } from '../../src/config/index.ts';

const address = (value: number) => `0x${value.toString(16).padStart(40, '0')}` as Address;
const deployment = Object.fromEntries([
  '404Pool', '404Token', '404Hasher', '404Market',
  '404Mint', '404Bundle', '404TransferVerifier', '404HoldVerifier',
].map((name, index) => [name, address(index + 1)]));
const config = create404Config({ chainId: 97, rpcUrl: 'https://rpc.example.invalid', deployment, deployBlock: 1n });
const markerSelector = toFunctionSelector('ASSET_ID_BITS()');

type RpcRequest = { id: number; method: string; params: unknown[] };

function rpcFetch(marker: 'missing' | 31 | 32): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    const success = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
    if (request.method === 'eth_chainId') return success('0x61');
    if (request.method === 'eth_getCode') return success('0x01');
    if (request.method !== 'eth_call') throw new Error(`unexpected RPC method ${request.method}`);

    const call = request.params[0] as { to: Address; data: Hex };
    if (call.data === markerSelector) {
      if (marker === 'missing') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'execution reverted' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return success(encodeFunctionResult({ abi: rawAbis.pool, functionName: 'ASSET_ID_BITS', result: marker }));
    }
    if (call.to.toLowerCase() === config.contracts.pool.toLowerCase()) {
      const tokenSelector = toFunctionSelector('token()');
      if (call.data === tokenSelector) return success(encodeFunctionResult({ abi: rawAbis.pool, functionName: 'token', result: config.contracts.token }));
      return success(encodeFunctionResult({ abi: rawAbis.pool, functionName: 'eip712Domain', result: [
        '0x0f', config.domains.pool.name, config.domains.pool.version, BigInt(config.chain.id), config.contracts.pool,
        `0x${'00'.repeat(32)}`, [],
      ] }));
    }
    if (call.to.toLowerCase() === config.contracts.market.toLowerCase()) {
      return success(encodeFunctionResult({ abi: rawAbis.market, functionName: 'eip712Domain', result: [
        '0x0f', config.domains.market.name, config.domains.market.version, BigInt(config.chain.id), config.contracts.market,
        `0x${'00'.repeat(32)}`, [],
      ] }));
    }
    if (call.to.toLowerCase() === config.contracts.token.toLowerCase()) {
      return success(encodeFunctionResult({ abi: rawAbis.token, functionName: 'decimals', result: config.tokenDecimals }));
    }
    throw new Error(`unexpected eth_call target ${call.to}`);
  };
}

async function withRpc<T>(marker: 'missing' | 31 | 32, operation: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = rpcFetch(marker);
  try { return await operation(); }
  finally { globalThis.fetch = original; }
}

test('openPool rejects deployments without the u32 compatibility marker', async () => {
  await assert.rejects(withRpc('missing', () => openPool(config)), /ASSET_ID_BITS\(\).*new deployment is required/);
});

test('openPool rejects deployments with a non-u32 compatibility marker', async () => {
  await assert.rejects(withRpc(31, () => openPool(config)), /ASSET_ID_BITS\(\).*new deployment is required/);
});

test('openPool accepts the u32 marker while retaining the two configured business assets', async () => {
  const connection = await withRpc(32, () => openPool(config));
  assert.equal(connection.config.contracts.pool, config.contracts.pool);
  assert.equal(connection.config.fees.length, 2);
  assert.deepEqual(connection.config.fees, [1_000_000_000n, 10_000n]);
});
