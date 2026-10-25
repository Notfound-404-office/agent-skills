import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseRelayer, fetchRelayerQuote, pricedFee, RelayerHttpError, submitRelay } from '../../src/relayer-client/index.ts';

const relayer = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';

test('quote parsing and submission use the original endpoints', async () => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    return url.includes('/quote?')
      ? Response.json({ relayer, chainId: 56, pool, fees: ['0', '105000'], pricing: { version: 2, gasLimit: '1000000', gasPriceWei: '1000000000', markupBps: 500 } })
      : Response.json({ txHash: `0x${'ab'.repeat(32)}` });
  }) as typeof fetch;
  const quote = await fetchRelayerQuote('https://relay.example/', { operation: 'native' }, fetcher);
  assert.equal(quote.url, 'https://relay.example');
  assert.equal(await submitRelay(quote, '/relay', { proof: '0x' }, fetcher), `0x${'ab'.repeat(32)}`);
  assert.deepEqual(requests, ['https://relay.example/quote?operation=native', 'https://relay.example/relay']);
  assert.equal(pricedFee(quote.pricing!), 105000n);
});

test('relayer selection rejects non-protocol fees and wrong identity', async () => {
  const config = { chain: { id: 56 }, contracts: { pool }, fees: [10n, 10000n], relayerUrls: ['https://bad', 'https://good'] } as never;
  const fetcher = (async (input: string | URL | Request) => {
    const good = String(input).startsWith('https://good');
    return Response.json({ relayer, chainId: 56, pool, fees: good ? ['10', '10000'] : ['11', '10000'] });
  }) as typeof fetch;
  assert.equal((await chooseRelayer(config, { operation: 'native', fetcher })).url, 'https://good');
});

test('market v2 refuses a v1 relayer before preparing or posting a payment', async () => {
  const config = { chain: { id: 56 }, contracts: { pool }, marketVersion: 2, fees: [10n, 10000n], relayerUrls: ['https://relay.example'] } as never;
  const fetcher = (async () => Response.json({ relayer, chainId: 56, pool, fees: ['10', '10000'] })) as typeof fetch;
  await assert.rejects(chooseRelayer(config, { operation: 'native', fetcher }), /different market version/);
});

test('priced quotes must match the exact gas budget plus five percent', async () => {
  const body = { relayer, chainId: 11155111, pool, fees: ['0', '104999'], marketVersion: 1,
    pricing: { version: 2, gasLimit: '1000000', gasPriceWei: '1000000000', markupBps: 500 } };
  await assert.rejects(fetchRelayerQuote('https://relay.example', { operation: 'native' }, async () => Response.json(body)), /does not match pricing/);
});

test('manual gas settings and mint count are sent as integer quote parameters', async () => {
  let requested = '';
  const body = { relayer, chainId: 11155111, pool, fees: ['0', '21'],
    pricing: { version: 2, gasLimit: '2', gasPriceWei: '100000000000', markupBps: 500 } };
  await fetchRelayerQuote('https://relay.example', { operation: 'mint', count: 7, gasLimit: 2n, gasPriceWei: 100_000_000_000n }, async input => {
    requested = String(input); return Response.json(body);
  });
  assert.equal(requested, 'https://relay.example/quote?operation=mint&count=7&gasLimit=2&gasPriceWei=100000000000');
});

test('a relayer cannot silently replace explicit manual gas settings', async () => {
  const body = { relayer, chainId: 11155111, pool, fees: ['0', '105000'],
    pricing: { version: 2, gasLimit: '1000000', gasPriceWei: '1000000000', markupBps: 500 } };
  await assert.rejects(
    fetchRelayerQuote('https://relay.example', { operation: 'native', gasLimit: 999999n }, async () => Response.json(body)),
    /changed the requested gas budget/,
  );
  await assert.rejects(
    fetchRelayerQuote('https://relay.example', { operation: 'native', gasPriceWei: 999999999n }, async () => Response.json(body)),
    /changed the requested gas price/,
  );
});

test('submit exposes an explicit pre-broadcast rejection', async () => {
  await assert.rejects(
    submitRelay({ url: 'https://relay.example' }, '/relay', {}, async () => Response.json({ error: 'GAS_PRICE_TOO_LOW', notBroadcast: true }, { status: 400 })),
    (error: unknown) => error instanceof RelayerHttpError && error.status === 400 && error.notBroadcast,
  );
});
