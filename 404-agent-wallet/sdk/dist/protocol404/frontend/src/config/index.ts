import { LEGACY_MARKET_DOMAIN, LEGACY_POOL_DOMAIN, LEGACY_SIGNING_PROFILE, normalizeSigningProfile } from '../compatibility.ts';

export type Address = `0x${string}`;
export type BscChainId = 56 | 97 | 11155111;
export type Contracts = {
  pool: Address;
  token: Address;
  hasher: Address;
  market: Address;
  mint: Address;
  bundle: Address;
  batchView?: Address;
  transferVerifier: Address;
  holdVerifier: Address;
};

export const upstreamDeployment = { chainId: 56, pool: '0x0000000000000000000000000000000000000000' } as const;

/** CONFIG: 404 private-address human-readable prefix. */
export const privateAddressPrefix = '404';

/** @orig index-CVtw0LZh.js:22160 MT CONFIG: original allowed token deposit denominations. */
export const depositLots = [1000n, 10000n, 100000n] as const;

/** @orig index-CVtw0LZh.js:18876 xC PROTOCOL: native notes use 8 decimals; 1 unit = 10^10 wei. */
export const nativeUnitWei = 10n ** 10n;

/** @orig index-CVtw0LZh.js:22165 LT CONFIG: fixed fees in note units, indexed [token, native]. */
export function relayerFees(tokenDecimals: number): readonly [bigint, bigint] {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255) {
    throw new RangeError('token decimals must be an integer from 0 to 255');
  }
  // Native fee: 10,000 note units * 10^10 wei = 0.0001 native.
  return [10n * 10n ** BigInt(tokenDecimals), 10000n];
}

/** @orig index-CVtw0LZh.js:22252 WT CONFIG: deploy.py JSON keys mapped to app names. */
const deploymentKeys = {
  pool: { canonical: '404Pool', legacy: ['PrivatePool'] },
  token: { canonical: '404Token', legacy: ['Token'] },
  hasher: { canonical: '404Hasher', legacy: ['PoseidonHasher'] },
  market: { canonical: '404Market', legacy: [] },
  mint: { canonical: '404Mint', legacy: [] },
  bundle: { canonical: '404Bundle', legacy: [] },
  batchView: { canonical: '404BatchView', legacy: [], optional: true },
  transferVerifier: { canonical: '404TransferVerifier', legacy: ['TransferVerifier'] },
  holdVerifier: { canonical: '404HoldVerifier', legacy: ['HoldVerifier'] },
} as const;

/** @orig index-CVtw0LZh.js:22403 tE Validate deployment input; no zero/old-chain placeholders. */
export function readDeployment(value: unknown): Contracts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('deployment must be an address object from deploy.py');
  }
  const input = value as Record<string, unknown>;
  const result = {} as Contracts;
  for (const key of Object.keys(deploymentKeys) as (keyof Contracts)[]) {
    const { canonical, legacy } = deploymentKeys[key];
    const names = [canonical, ...legacy].filter(name => Object.hasOwn(input, name));
    const address = names.length > 0 ? input[names[0]!] : undefined;
    if (names.length === 0 && 'optional' in deploymentKeys[key] && deploymentKeys[key].optional) continue;
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
      throw new Error(`missing or invalid deployment address: ${canonical}`);
    }
    for (const name of names.slice(1)) {
      const duplicate = input[name];
      if (typeof duplicate !== 'string' || duplicate.toLowerCase() !== address.toLowerCase()) {
        throw new Error(`conflicting deployment addresses: ${names.join(' and ')}`);
      }
    }
    result[key] = address as Address;
  }
  return result;
}

/** @orig index-CVtw0LZh.js:22375 qT CONFIG: caller-supplied endpoints, with no live defaults. */
function httpUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('endpoint must be an HTTP(S) URL without embedded credentials');
  }
  return value;
}

export type SigningProfile = '404' | typeof LEGACY_SIGNING_PROFILE;
export type SigningProfiles = { pool: SigningProfile; market: SigningProfile };
export type SigningProfilesInput = { pool: SigningProfile | 'bigwall-legacy'; market: SigningProfile | 'bigwall-legacy' };
export const legacySigningProfiles: SigningProfiles = { pool: LEGACY_SIGNING_PROFILE, market: LEGACY_SIGNING_PROFILE };

export type Protocol404ConfigInput = {
  chainId: BscChainId;
  rpcUrl: string;
  relayerUrls?: readonly string[];
  indexerUrls?: readonly string[];
  deployment: unknown;
  // deploy.py currently omits chainId and deployBlock: require these explicitly.
  deployBlock: bigint;
  marketVersion?: 1 | 2;
  marketBlock?: bigint | string;
  signingProfiles?: SigningProfilesInput;
  tokenName?: string;
  tokenSymbol?: string;
  localDevnet?: boolean;
  mintPolicy?: { mode: 'nft-self'; nft: Address; submission?: 'bound' | 'open'; free?: boolean };
};

/** @orig index-CVtw0LZh.js:22403 tE CONFIG: 404 deployment, separate from the original profile. */
export function create404Config(input: Protocol404ConfigInput) {
  if (input.chainId !== 56 && input.chainId !== 97 && input.chainId !== 11155111) throw new Error('unsupported chain id');
  if (typeof input.deployBlock !== 'bigint' || input.deployBlock < 0n) throw new Error('invalid deployment block');
  const contracts = readDeployment(input.deployment);
  const marketVersion = input.marketVersion ?? 1;
  if (marketVersion !== 1 && marketVersion !== 2) throw new Error('unsupported market version');
  if (typeof input.marketBlock === 'string' && !/^(0|[1-9][0-9]*)$/.test(input.marketBlock)) throw new Error('invalid market block');
  const marketBlock = BigInt(input.marketBlock ?? input.deployBlock);
  if (marketBlock < 0n) throw new Error('invalid market block');
  const rpcUrl = httpUrl(input.rpcUrl);
  if (input.mintPolicy && (input.mintPolicy.mode !== 'nft-self'
    || !/^0x[0-9a-fA-F]{40}$/.test(input.mintPolicy.nft) || /^0x0{40}$/i.test(input.mintPolicy.nft)
    || (input.mintPolicy.submission !== undefined && !['bound', 'open'].includes(input.mintPolicy.submission))
    || (input.mintPolicy.free !== undefined && typeof input.mintPolicy.free !== 'boolean'))) {
    throw new Error('invalid mint policy');
  }
  let signingProfiles: SigningProfiles;
  try {
    if (input.signingProfiles && (!Object.hasOwn(input.signingProfiles, 'pool') || !Object.hasOwn(input.signingProfiles, 'market'))) throw new Error();
    signingProfiles = {
      pool: normalizeSigningProfile(input.signingProfiles?.pool ?? '404'),
      market: normalizeSigningProfile(input.signingProfiles?.market ?? '404'),
    };
  } catch {
    throw new Error('unsupported signing profile');
  }
  const legacyPool = signingProfiles.pool === LEGACY_SIGNING_PROFILE;
  const sepolia = input.chainId === 11155111;
  return {
    chain: {
      id: input.chainId,
      name: sepolia ? 'Sepolia' : input.chainId === 97 ? 'BNB Smart Chain Testnet' : 'BNB Smart Chain',
      nativeCurrency: sepolia
        ? { name: 'Ether', symbol: 'ETH', decimals: 18 }
        : { name: 'BNB', symbol: 'BNB', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
      testnet: input.chainId !== 56,
    },
    contracts,
    mintPolicy: input.mintPolicy,
    localDevnet: input.localDevnet === true,
    deployBlock: input.deployBlock,
    marketVersion,
    marketBlock,
    relayerUrls: (input.relayerUrls ?? []).map(httpUrl),
    indexerUrls: (input.indexerUrls ?? input.relayerUrls ?? []).map(httpUrl),
    signingProfiles: { ...signingProfiles },
    brand: { name: '404', tokenName: input.tokenName ?? '404', tokenSymbol: input.tokenSymbol ?? '404', privateAddressPrefix },
    tokenDecimals: 8,
    fees: relayerFees(8),
    domains: {
      // CONFIG: must match the domain_patch.py names, not the token name.
      pool: { ...(legacyPool ? LEGACY_POOL_DOMAIN : { name: '404', version: '2' }), chainId: input.chainId, verifyingContract: contracts.pool },
      market: { ...(signingProfiles.market === LEGACY_SIGNING_PROFILE ? LEGACY_MARKET_DOMAIN : { name: '404 Market', version: '1' }), chainId: input.chainId, verifyingContract: contracts.market },
    },
  };
}

/** Explicit factory for deployments that retain the immutable predecessor signing domains. */
export type Legacy404ConfigInput = Protocol404ConfigInput;
export function createLegacy404Config(input: Legacy404ConfigInput) {
  return create404Config({ ...input, signingProfiles: input.signingProfiles ?? legacySigningProfiles });
}
