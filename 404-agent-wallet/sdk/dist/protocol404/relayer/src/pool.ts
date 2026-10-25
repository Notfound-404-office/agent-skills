import type { Address, Hex } from "viem";
import { type Contracts, type RelayCall } from "./calls.js";
import { HttpError, prepareRequest, type RelayService } from "./service.js";
import type { QuoteInput } from "./service.js";
import type { TradeIndexer } from "./trades.js";

export type RelayQuote = {
  relayer: Address;
  chainId: number;
  pool: Address;
  marketVersion?: 1 | 2;
  fees: string[];
  pricing?: { version: 2; gasLimit: string; gasPriceWei: string; markupBps: 500 };
  relayers?: readonly Address[];
  relayerCount?: number;
};

export interface RelayHandler {
  quote(input?: QuoteInput): Promise<RelayQuote>;
  submit(path: string, body: unknown): Promise<{ txHash: Hex }>;
  trades?(offset: number, limit: number): Promise<unknown>;
  tradeStats?(range: "1d" | "7d" | "30d" | "all"): Promise<unknown>;
}

/** Rotates quotes while routing signed requests back to their exact wallet. */
export class RelayServicePool implements RelayHandler {
  private cursor = 0;
  private readonly byAddress = new Map<string, RelayService>();
  private readonly relayers: readonly Address[];
  private readonly services: readonly RelayService[];
  private readonly contracts: Contracts;
  private readonly tradeIndexer?: TradeIndexer;

  constructor(services: readonly RelayService[], contracts: Contracts, tradeIndexer?: TradeIndexer) {
    if (services.length === 0) throw new Error("relayer pool is empty");
    this.services = services;
    this.contracts = contracts;
    this.tradeIndexer = tradeIndexer;
    for (const service of services) {
      const key = service.config.relayer.toLowerCase();
      if (this.byAddress.has(key)) throw new Error("duplicate relayer address");
      this.byAddress.set(key, service);
    }
    this.relayers = services.map(service => service.config.relayer);
  }

  async quote(input: QuoteInput = {}): Promise<RelayQuote> {
    const quote = await this.services[this.cursor++ % this.services.length].quote(input);
    return { ...quote, relayers: this.relayers, relayerCount: this.relayers.length };
  }

  async submit(path: string, body: unknown): Promise<{ txHash: Hex }> {
    const call = prepareRequest(path, body, this.contracts);
    const service = this.byAddress.get(this.target(call).toLowerCase());
    if (!service) throw new HttpError(400, "bad request: relayer");
    return service.submitCall(call);
  }

  trades(offset: number, limit: number): Promise<unknown> {
    if (!this.tradeIndexer) throw new HttpError(503, "trade history is unavailable");
    return this.tradeIndexer.list(offset, limit);
  }

  tradeStats(range: "1d" | "7d" | "30d" | "all"): Promise<unknown> {
    if (!this.tradeIndexer) throw new HttpError(503, "trade history is unavailable");
    return this.tradeIndexer.stats(range);
  }

  private target(call: RelayCall): Address {
    if (call.feeTx) return call.feeTx.ext.relayer;
    if (call.release?.direct) return call.release.signed.release.relayer;
    throw new HttpError(400, "bad request: relayer");
  }
}
