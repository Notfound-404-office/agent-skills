/** Immutable identifiers retained so existing deployments and wallets remain usable. */
export const LEGACY_SIGNING_PROFILE = 'legacy-v1' as const;
export const PREDECESSOR_SIGNING_PROFILE = 'bigwall-legacy' as const;
export const LEGACY_POOL_DOMAIN = { name: 'BigWall', version: '2' } as const;
export const LEGACY_MARKET_DOMAIN = { name: 'BigWall Market', version: '1' } as const;
export const LEGACY_WALLET_AAD = 'pm-wallet-v1';
export const LEGACY_WALLET_STORAGE_KEY = 'pm.wallet';
export const LEGACY_JOURNAL_DB = 'bigwall-wallet';
export const LEGACY_PAYMENT_LOCK_PREFIX = 'bigwall-payments:';

export function normalizeSigningProfile(value: unknown): '404' | typeof LEGACY_SIGNING_PROFILE {
  if (value === '404' || value === LEGACY_SIGNING_PROFILE) return value;
  if (value === PREDECESSOR_SIGNING_PROFILE) return LEGACY_SIGNING_PROFILE;
  throw new Error('unsupported signing profile');
}
