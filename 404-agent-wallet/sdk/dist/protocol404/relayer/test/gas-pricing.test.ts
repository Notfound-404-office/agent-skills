import assert from "node:assert/strict";
import test from "node:test";
import { type Address, type Hex } from "viem";
import { prepareCall, type Contracts } from "../src/calls.js";
import { ConcurrencyGate, gasFeeUnits, HttpError, RelayService, type ChainAdapter } from "../src/service.js";

const relayer = "0x1111111111111111111111111111111111111111" as Address;
const contracts: Contracts = {
  pool: "0x2222222222222222222222222222222222222222",
  market: "0x4444444444444444444444444444444444444444",
  mint: "0x5555555555555555555555555555555555555555",
  bundle: "0x6666666666666666666666666666666666666666",
};
const ciphertext = `0x${"00".repeat(175)}` as Hex;
const pricing = { version: 2, gasLimit: "6500000", gasPriceWei: "50000000", markupBps: 500 } as const;

function transaction(fee = "34125", asset = "1") {
  return {
    proof: "0x" as Hex,
    pub: { root: "1", nullifiers: ["2", "0"], commitments: ["3", "4"], nowTs: "5", asset, publicOut: "0", fee },
    ext: {
      recipient: "0x0000000000000000000000000000000000000000" as Address,
      relayer,
      caller: "0x0000000000000000000000000000000000000000" as Address,
      data: `0x${"00".repeat(32)}` as Hex,
      ciphertexts: [ciphertext, ciphertext],
    },
    pricing,
  };
}

function chain(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async gasFees() { return { gasPrice: 60_000_000n, baseFee: 40_000_000n }; },
    async call() {},
    async estimateGas() { return 5_000_000n; },
    async send() { return `0x${"ab".repeat(32)}`; },
    ...overrides,
  };
}

function service(adapter: ChainAdapter, maxConcurrent = 2) {
  return new RelayService({
    chainId: 11155111, relayer, contracts, fees: [1_000_000_000n, 10_000n], feeMode: "gas-plus",
    gasCap: 12_000_000n, maxConcurrent, reservationMs: 500,
  }, adapter);
}

test("gas-plus quotes use exact 5% ceil and accept a manual 0.05 gwei price", async () => {
  assert.equal(gasFeeUnits(1n, 1n), 1n);
  const quote = await service(chain()).quote({ operation: "native", gasPriceWei: "50000000" });
  assert.deepEqual(quote.fees, ["0", "34125"]);
  assert("pricing" in quote);
  assert.deepEqual(quote.pricing, pricing);
  await assert.rejects(service(chain()).quote({ operation: "unknown" }), /operation/);
  await assert.rejects(service(chain()).quote({ operation: "native", gasPriceWei: "39999999" }), /GAS_PRICE_TOO_LOW/);
});

test("mint quotes and requests accept exactly one lot", async () => {
  const relay = service(chain());
  const quote = await relay.quote({ operation: "mint", count: "1", gasPriceWei: "50000000" });
  assert("pricing" in quote);
  assert.equal(quote.pricing.gasLimit, "8000000");
  await assert.rejects(relay.quote({ operation: "mint", count: "2" }), /mint count must be 1/);
  const tx = transaction();
  tx.ext.caller = contracts.mint;
  const request = { tx, mint: { inners: ["1", "2"], ciphertexts: [ciphertext, ciphertext] } };
  await assert.rejects(relay.submit("/mint", request), error => error instanceof HttpError && error.status === 400 && /exactly one lot/.test(error.message));
});

test("gas-plus rejects missing or tampered pricing and never accepts token fees", async () => {
  const relay = service(chain());
  const missing = transaction();
  delete (missing as { pricing?: unknown }).pricing;
  await assert.rejects(relay.submit("/relay", missing), /pricing required/);
  assert.throws(() => prepareCall("/relay", { ...transaction(), pricing: { ...pricing, markupBps: 499 } }, contracts), /pricing/);
  await assert.rejects(relay.submit("/relay", transaction("34124")), /bad request: fee/);
  await assert.rejects(relay.submit("/relay", transaction("34125", "0")), /native fee required/);
});

test("gas-plus enforces the quoted budget and sends with the exact quoted gas and price", async () => {
  let sent: { gas: bigint; gasPrice?: bigint } | undefined;
  const simulated: Array<{ gas?: bigint; gasPrice?: bigint }> = [];
  const relay = service(chain({
    async call(request) { simulated.push(request); },
    async estimateGas(request) { simulated.push(request); return 5_000_000n; },
    async send(request) { sent = request; return `0x${"ab".repeat(32)}`; },
  }));
  await relay.submit("/relay", transaction());
  assert.deepEqual(simulated.map(request => [request.gas, request.gasPrice]), [[12_000_000n, 50_000_000n], [12_000_000n, 50_000_000n]]);
  assert.equal(sent?.gas, 6_500_000n);
  assert.equal(sent?.gasPrice, 50_000_000n);

  const lowTx = transaction("5250");
  lowTx.pub.nullifiers[0] = "9";
  const low = { ...lowTx, pricing: { ...pricing, gasLimit: "1000000" } };
  await assert.rejects(relay.submit("/relay", low), error => error instanceof HttpError && error.status === 422 && error.message === "GAS_BUDGET_TOO_LOW");
});

test("concurrency is acquired before release order reads", async () => {
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let reads = 0;
  const adapter = chain({ async readOrder() { reads++; await blocked; return { sellAsset: 0, releases: 0 }; } });
  const gate = new ConcurrencyGate(1);
  const relay = new RelayService({
    chainId: 11155111, relayer, contracts, fees: [1_000_000_000n, 10_000n], feeMode: "gas-plus",
    gasCap: 12_000_000n, maxConcurrent: 1, reservationMs: 500,
  }, adapter, undefined, gate);
  const release = {
    action: 0,
    release: { orderId: "1", inner: "2", ciphertext, relayer, fee: "34125", deadline: "3" },
    signature: `0x${"11".repeat(65)}`,
    pricing,
  };
  const first = relay.submit("/release", release);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(relay.submit("/release", release), error => error instanceof HttpError && error.status === 503);
  assert.equal(reads, 1);
  unblock?.();
  await first;
});
