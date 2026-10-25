import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { Contracts } from "./calls.js";
import { LEGACY_SIGNING_DOMAINS, LEGACY_SIGNING_PROFILE, normalizeSigningProfile } from "./compatibility.js";

export type SigningProfile = "404" | typeof LEGACY_SIGNING_PROFILE;

export const SIGNING_DOMAINS = {
  "404": { pool: { name: "404", version: "2" }, market: { name: "404 Market", version: "1" } },
  [LEGACY_SIGNING_PROFILE]: LEGACY_SIGNING_DOMAINS,
} as const;

export type RelayerConfig = {
  host: string;
  port: number;
  rpcUrl: string;
  chainId: 56 | 97 | 11155111;
  privateKey: Hex;
  privateKeys: readonly Hex[];
  contracts: Contracts;
  fees: readonly [bigint, bigint];
  feeMode: "fixed" | "gas-plus";
  gasCap: bigint;
  maxConcurrent: number;
  reservationMs: number;
  bodyLimit: number;
  corsOrigin?: string;
  marketBlock?: bigint;
  signingProfiles: { pool: SigningProfile; market: SigningProfile };
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function address(env: NodeJS.ProcessEnv, name: string): Address {
  const value = required(env, name);
  if (!isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) throw new Error(`invalid ${name}`);
  return getAddress(value);
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`invalid ${name}`);
  return parsed;
}

function corsOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && value === url.origin) return value;
  } catch {}
  throw new Error("invalid RELAYER_CORS_ORIGIN");
}

function privateKeys(env: NodeJS.ProcessEnv): readonly Hex[] {
  if (env.RELAYER_PRIVATE_KEYS === undefined) {
    const key = required(env, "RELAYER_PRIVATE_KEY");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("invalid RELAYER_PRIVATE_KEY");
    return [key as Hex];
  }
  let values: unknown;
  try { values = JSON.parse(env.RELAYER_PRIVATE_KEYS); }
  catch { throw new Error("invalid RELAYER_PRIVATE_KEYS"); }
  if (!Array.isArray(values) || values.length === 0 || values.length > 32 || values.some(value => typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))) {
    throw new Error("invalid RELAYER_PRIVATE_KEYS");
  }
  return [...new Map(values.map(value => [value.toLowerCase(), value as Hex])).values()];
}

function signingProfile(env: NodeJS.ProcessEnv, name: "RELAYER_POOL_PROFILE" | "RELAYER_MARKET_PROFILE"): SigningProfile {
  const value = env[name] ?? "404";
  try { return normalizeSigningProfile(value); }
  catch { throw new Error(`${name} must be 404 or ${LEGACY_SIGNING_PROFILE}`); }
}

/** Read deployment/runtime values only from environment; no credential defaults. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const chainId = Number(required(env, "RELAYER_CHAIN_ID"));
  if (chainId !== 56 && chainId !== 97 && chainId !== 11155111) throw new Error("RELAYER_CHAIN_ID must be 56, 97, or 11155111");
  const rpcUrl = required(env, "RELAYER_RPC_URL");
  const url = new URL(rpcUrl);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("invalid RELAYER_RPC_URL");
  const keys = privateKeys(env);
  const fees = [BigInt(env.RELAYER_TOKEN_FEE ?? "1000000000"), BigInt(env.RELAYER_NATIVE_FEE ?? "10000")] as const;
  const gasCap = BigInt(env.RELAYER_GAS_CAP ?? "12000000");
  const feeMode = env.RELAYER_FEE_MODE ?? "gas-plus";
  if (feeMode !== "fixed" && feeMode !== "gas-plus") throw new Error("RELAYER_FEE_MODE must be fixed or gas-plus");
  const marketVersion = Number(env.RELAYER_MARKET_VERSION ?? "1");
  if (marketVersion !== 1 && marketVersion !== 2) throw new Error("RELAYER_MARKET_VERSION must be 1 or 2");
  if (env.RELAYER_MARKET_BLOCK !== undefined && !/^(0|[1-9][0-9]*)$/.test(env.RELAYER_MARKET_BLOCK)) throw new Error("invalid RELAYER_MARKET_BLOCK");
  const marketBlock = env.RELAYER_MARKET_BLOCK === undefined ? undefined : BigInt(env.RELAYER_MARKET_BLOCK);
  if (marketBlock !== undefined && marketBlock < 0n) throw new Error("invalid RELAYER_MARKET_BLOCK");
  if (fees.some(fee => fee < 0n || fee >= 1n << 64n)) throw new Error("relayer fees must fit uint64");
  if (gasCap <= 0n) throw new Error("RELAYER_GAS_CAP must be positive");
  return {
    host: env.RELAYER_HOST ?? "127.0.0.1",
    port: positiveInteger(env, "RELAYER_PORT", 8787),
    rpcUrl,
    chainId,
    privateKey: keys[0],
    privateKeys: keys,
    contracts: {
      pool: address(env, "RELAYER_POOL"), market: address(env, "RELAYER_MARKET"),
      mint: address(env, "RELAYER_MINT"), bundle: address(env, "RELAYER_BUNDLE"), marketVersion,
    },
    fees,
    feeMode,
    gasCap,
    maxConcurrent: positiveInteger(env, "RELAYER_MAX_CONCURRENT", 4),
    reservationMs: positiveInteger(env, "RELAYER_RESERVATION_MS", 180_000),
    bodyLimit: positiveInteger(env, "RELAYER_BODY_LIMIT", 262_144),
    corsOrigin: corsOrigin(env.RELAYER_CORS_ORIGIN),
    marketBlock,
    signingProfiles: {
      pool: signingProfile(env, "RELAYER_POOL_PROFILE"),
      market: signingProfile(env, "RELAYER_MARKET_PROFILE"),
    },
  };
}
