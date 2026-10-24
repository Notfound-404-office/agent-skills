import { isAddress, isAddressEqual, type Address, type Hex } from 'viem';
import type { AppConfig } from '../chain/client.ts';

export type RelayerQuote = Readonly<{
  url: string;
  relayer: Address;
  chainId: number;
  pool: Address;
  fees: readonly [bigint, bigint];
  marketVersion?: 1 | 2;
  pricing?: RelayerPricing;
}>;

export type RelayOperation = 'native' | 'token' | 'mint' | 'release' | 'token-release' | 'sweep';
export type FeePreferences = Readonly<{ gasLimit?: bigint; gasPriceWei?: bigint }>;
export type QuoteOptions = FeePreferences & Readonly<{ operation: RelayOperation; count?: number }>;
export type RelayerPricing = Readonly<{
  version: 2;
  gasLimit: bigint;
  gasPriceWei: bigint;
  markupBps: 500;
}>;

export type RelayPath = '/relay' | '/order' | '/fill' | '/sweep' | '/mint' | '/bundle' | '/release';

export class RelayerHttpError extends Error {
  readonly status: number;
  readonly notBroadcast: boolean;
  constructor(status: number, message: string, notBroadcast: boolean) {
    super(`relayer ${status}: ${message}`);
    this.status = status;
    this.notBroadcast = notBroadcast;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new RelayerHttpError(
    response.status,
    typeof body.error === 'string' ? body.error : 'error',
    body.notBroadcast === true,
  );
  return body;
}

/** @orig index-CVtw0LZh.js:26804 dD Fetch and structurally validate a relayer quote. */
export function pricedFee(pricing: Pick<RelayerPricing, 'gasLimit' | 'gasPriceWei' | 'markupBps'>): bigint {
  const numerator = pricing.gasLimit * pricing.gasPriceWei * BigInt(10_000 + pricing.markupBps);
  const denominator = 10_000n * 10_000_000_000n;
  return (numerator + denominator - 1n) / denominator;
}

function positiveInteger(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,30}$/.test(value)) throw new Error(`relayer quote has invalid ${label}`);
  return BigInt(value);
}

export async function fetchRelayerQuote(
  url: string,
  options: QuoteOptions,
  fetcher: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<RelayerQuote> {
  const normalized = url.replace(/\/+$/, '');
  const query = new URLSearchParams({ operation: options.operation });
  if (options.count !== undefined) query.set('count', String(options.count));
  if (options.gasLimit !== undefined) query.set('gasLimit', options.gasLimit.toString());
  if (options.gasPriceWei !== undefined) query.set('gasPriceWei', options.gasPriceWei.toString());
  const body = await readJson(await fetcher(`${normalized}/quote?${query}`, { signal: AbortSignal.timeout(timeoutMs) }));
  const fees = body.fees;
  if (!Array.isArray(fees) || fees.length !== 2 || fees.some(value => typeof value !== 'string' || !/^(0|[1-9][0-9]{0,30})$/.test(value))) {
    throw new Error('relayer quote has no fee list (an older relayer?)');
  }
  if (typeof body.relayer !== 'string' || typeof body.pool !== 'string'
    || !isAddress(body.relayer, { strict: false }) || !isAddress(body.pool, { strict: false }) || !Number.isSafeInteger(body.chainId)) {
    throw new Error('relayer quote has invalid identity');
  }
  const marketVersion = body.marketVersion ?? 1;
  if (marketVersion !== 1 && marketVersion !== 2) throw new Error('relayer quote has invalid market version');
  let pricing: RelayerPricing | undefined;
  if (body.pricing !== undefined) {
    if (!body.pricing || typeof body.pricing !== 'object') throw new Error('relayer quote has invalid pricing');
    const raw = body.pricing as Record<string, unknown>;
    if (raw.version !== 2 || raw.markupBps !== 500) throw new Error('relayer quote has unsupported pricing');
    pricing = { version: 2, gasLimit: positiveInteger(raw.gasLimit, 'gas budget'), gasPriceWei: positiveInteger(raw.gasPriceWei, 'gas price'), markupBps: 500 };
    if (options.gasLimit !== undefined && pricing.gasLimit !== options.gasLimit) throw new Error('relayer quote changed the requested gas budget');
    if (options.gasPriceWei !== undefined && pricing.gasPriceWei !== options.gasPriceWei) throw new Error('relayer quote changed the requested gas price');
    if (BigInt(fees[0] as string) !== 0n || BigInt(fees[1] as string) !== pricedFee(pricing)) {
      throw new Error('relayer quote fee does not match pricing');
    }
  }
  return {
    url: normalized,
    relayer: body.relayer,
    chainId: body.chainId as number,
    pool: body.pool,
    fees: [BigInt(fees[0] as string), BigInt(fees[1] as string)],
    marketVersion,
    pricing,
  };
}

/** @orig index-CVtw0LZh.js:26849 gD Try configured relayers in stable order and reject wrong chain/pool/fees. */
export async function chooseRelayer(
  config: AppConfig,
  options: QuoteOptions & { prefer?: string; avoid?: string; fetcher?: typeof fetch },
): Promise<RelayerQuote> {
  const urls = [...new Set(config.relayerUrls.map(url => url.replace(/\/+$/, '')))];
  if (!urls.length) throw new Error('No relayer is configured');
  const available = urls.filter(url => url !== options.avoid);
  const preferred = options.prefer && available.includes(options.prefer) ? [options.prefer] : [];
  const order = [...new Set([...preferred, ...available, ...urls.filter(url => url === options.avoid)])];
  const failures: string[] = [];
  for (const url of order) {
    try {
      const quote = await fetchRelayerQuote(url, options, options.fetcher);
      if (quote.chainId !== config.chain.id || !isAddressEqual(quote.pool, config.contracts.pool)) {
        throw new Error('This relayer serves a different chain or pool');
      }
      // BSC V1 relayers predate gas-plus pricing. Sepolia never silently falls back to them.
      if (!quote.pricing && (config.chain.id === 11155111
        || quote.fees[0] !== config.fees[0] || quote.fees[1] !== config.fees[1])) throw new Error('This relayer does not provide gas-plus pricing');
      if (quote.marketVersion !== (config.marketVersion ?? 1)) throw new Error('This relayer serves a different market version');
      return quote;
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`no relayer available: ${failures.join('; ')}`);
}

/** @orig index-CVtw0LZh.js:26789-26840 cD/lD/fD POST a prepared request to an original relayer path. */
export async function submitRelay(
  quote: Pick<RelayerQuote, 'url'>,
  path: RelayPath,
  body: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Hex> {
  const response = await fetcher(`${quote.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const value = await readJson(response);
  if (typeof value.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.txHash)) {
    throw new Error('relayer returned an invalid transaction hash');
  }
  return value.txHash as Hex;
}
