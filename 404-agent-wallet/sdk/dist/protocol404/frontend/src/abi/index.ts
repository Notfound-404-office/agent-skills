import token from './Protocol404Token.ts';
import hasher from './Protocol404Hasher.ts';
import pool from './Protocol404Pool.ts';
import bundle from './Protocol404Bundle.ts';
import market from './Protocol404Market.ts';
import marketV2 from './Protocol404MarketV2.ts';
import mint from './Protocol404Mint.ts';
import transferVerifier from './Protocol404TransferVerifier.ts';
import holdVerifier from './Protocol404HoldVerifier.ts';

type AbiNode = { name?: string; type?: string; internalType?: string; inputs?: readonly AbiNode[]; outputs?: readonly AbiNode[]; components?: readonly AbiNode[] };

/** Keep the extracted artifacts as historical input while serving the current u32 asset ABI. */
function u32AssetAbi<T>(value: T): T {
  if (Array.isArray(value)) return value.map(u32AssetAbi) as T;
  if (!value || typeof value !== 'object') return value;
  const node = value as AbiNode;
  const converted = node.type === 'uint8' && ['asset', 'assetIn', 'sellAsset'].includes(node.name ?? '');
  const outputs = node.type === 'function' && ['NATIVE', 'TOKEN_ASSET'].includes(node.name ?? '')
    ? node.outputs?.map(output => output.type === 'uint8' ? { ...output, type: 'uint32', internalType: output.internalType === 'uint8' ? 'uint32' : output.internalType } : output)
    : node.outputs;
  return {
    ...node,
    ...(converted ? { type: 'uint32', internalType: node.internalType === 'uint8' ? 'uint32' : node.internalType } : {}),
    ...(node.inputs ? { inputs: u32AssetAbi(node.inputs) } : {}),
    ...(outputs ? { outputs: u32AssetAbi(outputs) } : {}),
    ...(node.components ? { components: u32AssetAbi(node.components) } : {}),
  } as T;
}

/** @orig index-CVtw0LZh.js:22495 dE Original artifact ABIs, extracted offline. */
export const historicalRawAbis = { token, hasher, pool, bundle, market, mint, transferVerifier, holdVerifier };
const assetIdBits = { type: 'function', name: 'ASSET_ID_BITS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] } as const;
export const rawAbis = {
  token, hasher, transferVerifier, holdVerifier,
  pool: [...u32AssetAbi(pool), assetIdBits] as const, bundle: u32AssetAbi(bundle), market: u32AssetAbi(market),
  mint: u32AssetAbi(mint),
};

/** Select the market generation within the u32 protocol. */
export const marketAbi = (version: 1 | 2 = 1) => version === 2 ? marketV2 : rawAbis.market;
export { marketV2 };

/** @orig index-CVtw0LZh.js:26224 mE Verifier errors can bubble through pool calls. */
const verifierErrors = transferVerifier.filter(entry => entry.type === 'error');

/** @orig index-CVtw0LZh.js:26232 gE Satellites also bubble pool and verifier errors. */
const poolErrors = rawAbis.pool.filter(entry => entry.type === 'error');

/** @orig index-CVtw0LZh.js:26225 hE Preserve original SDK error composition and order. */
export const abis = {
  ...rawAbis,
  pool: [...rawAbis.pool, ...verifierErrors],
  market: [...rawAbis.market, ...poolErrors, ...verifierErrors],
};
