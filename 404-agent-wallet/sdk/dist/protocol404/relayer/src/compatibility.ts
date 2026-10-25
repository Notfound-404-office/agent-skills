/** Explicit compatibility profile for deployments signed with the predecessor domains. */
export const LEGACY_SIGNING_PROFILE = 'legacy-v1' as const;
export const PREDECESSOR_SIGNING_PROFILE = 'bigwall-legacy' as const;
export const LEGACY_SIGNING_DOMAINS = {
  pool: { name: 'BigWall', version: '2' },
  market: { name: 'BigWall Market', version: '1' },
} as const;

export function normalizeSigningProfile(value: string): '404' | typeof LEGACY_SIGNING_PROFILE {
  if (value === '404' || value === LEGACY_SIGNING_PROFILE) return value;
  if (value === PREDECESSOR_SIGNING_PROFILE) return LEGACY_SIGNING_PROFILE;
  throw new Error('unsupported signing profile');
}
