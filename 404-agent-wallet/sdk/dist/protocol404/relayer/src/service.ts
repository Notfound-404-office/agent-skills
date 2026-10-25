import type { Address, Hex } from "viem";
import { prepareCall, type Contracts, type RelayCall, type RelayPricing } from "./calls.js";

const U64 = 1n << 64n;
const GAS_DEFAULTS = {
  native: 6_500_000n,
  token: 12_000_000n,
  release: 2_000_000n,
  "token-release": 8_000_000n,
  sweep: 12_000_000n,
} as const;
export type QuoteOperation = keyof typeof GAS_DEFAULTS | "mint";
export type QuoteInput = { operation?: string; count?: string; gasLimit?: string; gasPriceWei?: string };

export interface ChainAdapter {
  readOrder(orderId: bigint): Promise<{ sellAsset: number; releases: number }>;
  gasFees?(): Promise<{ gasPrice: bigint; baseFee: bigint }>;
  call(request: { account: Address; to: Address; data: Hex; gas?: bigint; gasPrice?: bigint }): Promise<void>;
  estimateGas(request: { account: Address; to: Address; data: Hex; gas?: bigint; gasPrice?: bigint }): Promise<bigint>;
  send(request: { account: Address; to: Address; data: Hex; gas: bigint; gasPrice?: bigint }): Promise<Hex>;
}

export type ServiceConfig = {
  chainId: number;
  relayer: Address;
  contracts: Contracts;
  fees: readonly [bigint, bigint];
  feeMode?: "fixed" | "gas-plus";
  gasCap: bigint;
  maxConcurrent: number;
  reservationMs: number;
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class BroadcastOutcomeUnknownError extends Error {
  constructor(cause: unknown) { super("broadcast outcome unknown", { cause }); }
}

export function prepareRequest(path: string, body: unknown, contracts: Contracts): RelayCall {
  try { return prepareCall(path, body, contracts); }
  catch (error) {
    const message = error instanceof Error && error.message.startsWith("bad request:") ? error.message : "bad request";
    throw new HttpError(400, message);
  }
}

function positiveDecimal(value: string | undefined, label: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,77}$/.test(value)) throw new HttpError(400, `bad request: ${label}`);
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) throw new HttpError(400, `bad request: ${label}`);
  return parsed;
}

export function gasFeeUnits(gasLimit: bigint, gasPriceWei: bigint): bigint {
  const units = (gasLimit * gasPriceWei * 105n + 999_999_999_999n) / 1_000_000_000_000n;
  if (units >= U64) throw new HttpError(422, "gas fee exceeds uint64");
  return units;
}

/** Atomic in-memory request reservation for one relayer process. */
export class ReservationBook {
  private readonly held = new Map<string, { timer: ReturnType<typeof setTimeout>; token: symbol }>();

  reserve(values: readonly string[], ttlMs: number): () => void {
    const keys = [...new Set(values)];
    if (keys.some(key => this.held.has(key))) throw new HttpError(409, "another request spending these nullifiers is being submitted");
    const token = Symbol();
    const timer = setTimeout(() => this.release(keys, token), ttlMs);
    timer.unref();
    for (const key of keys) {
      this.held.set(key, { timer, token });
    }
    return () => this.release(keys, token);
  }

  private release(keys: readonly string[], token: symbol): void {
    for (const key of keys) {
      const held = this.held.get(key);
      if (!held || held.token !== token) continue;
      clearTimeout(held.timer);
      this.held.delete(key);
    }
  }
}

/** Process-wide submission limit shared by every relayer wallet. */
export class ConcurrencyGate {
  private active = 0;
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }

  get full(): boolean { return this.active >= this.limit; }

  acquire(): () => void {
    if (this.full) throw new HttpError(503, "relayer is at concurrency limit");
    this.active++;
    return () => { this.active--; };
  }
}

/** Validates fee identity, simulates, estimates, caps gas, then broadcasts. */
export class RelayService {
  readonly reservations: ReservationBook;
  readonly config: ServiceConfig;
  readonly chain: ChainAdapter;
  private readonly concurrency: ConcurrencyGate;

  constructor(
    config: ServiceConfig,
    chain: ChainAdapter,
    reservations = new ReservationBook(),
    concurrency = new ConcurrencyGate(config.maxConcurrent),
  ) { this.config = config; this.chain = chain; this.reservations = reservations; this.concurrency = concurrency; }

  async quote(input: QuoteInput = {}) {
    const base = { relayer: this.config.relayer, chainId: this.config.chainId, pool: this.config.contracts.pool, marketVersion: this.config.contracts.marketVersion ?? 1 };
    if (this.config.feeMode !== "gas-plus") return { ...base, fees: this.config.fees.map(String) };
    const leave = this.concurrency.acquire();
    try {
      const operation = (input.operation ?? "native") as QuoteOperation;
      if (operation !== "mint" && !Object.hasOwn(GAS_DEFAULTS, operation)) throw new HttpError(400, "bad request: operation");
      if (input.count !== undefined && (input.count !== "1" || operation !== "mint")) throw new HttpError(400, "bad request: mint count must be 1");
      const defaultGas = operation === "mint" ? 8_000_000n : GAS_DEFAULTS[operation];
      const gasLimit = positiveDecimal(input.gasLimit, "gasLimit") ?? defaultGas;
      if (gasLimit > this.config.gasCap) throw new HttpError(422, "gas limit exceeds server cap");
      const network = await this.networkFees();
      const manualPrice = positiveDecimal(input.gasPriceWei, "gasPriceWei");
      const gasPriceWei = manualPrice ?? (this.config.chainId === 11155111 && network.gasPrice < 1_000_000_000n ? 1_000_000_000n : network.gasPrice);
      if (gasPriceWei < network.baseFee) throw new HttpError(422, "GAS_PRICE_TOO_LOW");
      const fee = gasFeeUnits(gasLimit, gasPriceWei);
      return { ...base, fees: ["0", String(fee)], pricing: { version: 2, gasLimit: String(gasLimit), gasPriceWei: String(gasPriceWei), markupBps: 500 } as const };
    } finally { leave(); }
  }

  async submit(path: string, body: unknown): Promise<{ txHash: Hex }> {
    return this.submitCall(prepareRequest(path, body, this.config.contracts));
  }

  async submitCall(call: RelayCall): Promise<{ txHash: Hex }> {
    const leave = this.concurrency.acquire();
    let release: (() => void) | undefined;
    let broadcastAttempted = false;
    try {
      const pricing = await this.enforcePricing(call);
      const releaseKey = await this.enforceFee(call, pricing);
      const reservationKeys = call.nullifiers
        .filter(value => BigInt(value) !== 0n)
        .map(value => `nullifier:${BigInt(value)}`);
      if (releaseKey) reservationKeys.push(releaseKey);
      release = this.reservations.reserve(reservationKeys, this.config.reservationMs);
      const request = { account: this.config.relayer, to: call.to, data: call.data };
      const simulation = { ...request, ...(pricing ? { gas: this.config.gasCap, gasPrice: pricing.gasPriceWei } : {}) };
      await this.chain.call(simulation);
      const estimate = await this.chain.estimateGas(simulation);
      if (estimate > this.config.gasCap) throw new HttpError(422, `estimated gas ${estimate} exceeds cap ${this.config.gasCap}`);
      const padded = pricing ? (estimate * 120n + 99n) / 100n : estimate * 120n / 100n;
      const required = padded > this.config.gasCap ? this.config.gasCap : padded;
      if (pricing && pricing.gasLimit < required) throw new HttpError(422, "GAS_BUDGET_TOO_LOW");
      const gas = pricing?.gasLimit ?? required;
      broadcastAttempted = true;
      let txHash: Hex;
      try { txHash = await this.chain.send({ ...request, gas, ...(pricing ? { gasPrice: pricing.gasPriceWei } : {}) }); }
      catch (error) { throw new BroadcastOutcomeUnknownError(error); }
      return { txHash };
    } finally {
      leave();
      if (!broadcastAttempted) release?.();
    }
  }

  private async networkFees(): Promise<{ gasPrice: bigint; baseFee: bigint }> {
    if (!this.chain.gasFees) throw new HttpError(503, "gas pricing is unavailable");
    return this.chain.gasFees();
  }

  private async enforcePricing(call: RelayCall): Promise<RelayPricing | undefined> {
    if (this.config.feeMode !== "gas-plus") return undefined;
    if (!call.pricing) throw new HttpError(400, "bad request: pricing required");
    if (call.pricing.gasLimit > this.config.gasCap) throw new HttpError(422, "gas limit exceeds server cap");
    const { baseFee } = await this.networkFees();
    if (call.pricing.gasPriceWei < baseFee) throw new HttpError(422, "GAS_PRICE_TOO_LOW");
    return call.pricing;
  }

  private async enforceFee(call: RelayCall, pricing?: RelayPricing): Promise<string | undefined> {
    const dynamicFee = pricing ? gasFeeUnits(pricing.gasLimit, pricing.gasPriceWei) : undefined;
    if (call.feeTx) {
      const asset = Number(call.feeTx.pub.asset);
      if (pricing && asset !== 1) throw new HttpError(400, "bad request: native fee required");
      if (BigInt(call.feeTx.pub.fee) !== (dynamicFee ?? this.config.fees[asset])) throw new HttpError(400, "bad request: fee");
      if (call.feeTx.ext.relayer.toLowerCase() !== this.config.relayer.toLowerCase()) throw new HttpError(400, "bad request: relayer");
    }
    if (call.release) {
      const { signed, direct } = call.release;
      const release = signed.release;
      if (direct && release.relayer.toLowerCase() !== this.config.relayer.toLowerCase()) throw new HttpError(400, "bad request: relayer");
      const order = await this.chain.readOrder(BigInt(release.orderId));
      if (order.sellAsset !== 0 && order.sellAsset !== 1) throw new HttpError(400, "bad request: order asset");
      if (direct) {
        const releaseAsset = signed.action === 0 ? 1 - order.sellAsset : order.sellAsset;
        if (pricing && releaseAsset !== 1) throw new HttpError(400, "bad request: token release requires bundle");
        if (BigInt(release.fee) !== (dynamicFee ?? this.config.fees[releaseAsset])) throw new HttpError(400, "bad request: fee");
      }
      return `release:${BigInt(release.orderId)}:${order.releases}`;
    }
  }
}
