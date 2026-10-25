import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { prepareCall, type Contracts } from "../src/calls.js";
import { readConfig } from "../src/config.js";
import { TradeIndexer, type MarketEvent, type TradeSource } from "../src/trades.js";

const market = "0x4444444444444444444444444444444444444444" as Address;
const relayer = "0x1111111111111111111111111111111111111111" as Address;
const ciphertext = `0x${"00".repeat(175)}` as Hex;
const contracts: Contracts = {
  pool: "0x2222222222222222222222222222222222222222",
  market, mint: "0x5555555555555555555555555555555555555555", bundle: "0x6666666666666666666666666666666666666666", marketVersion: 2,
};

function tx(data: Hex) {
  return {
    proof: "0x" as Hex,
    pub: { root: "1", nullifiers: ["2", "0"], commitments: ["3", "4"], nowTs: "5", asset: "1", publicOut: "101", fee: "10000" },
    ext: { recipient: "0x0000000000000000000000000000000000000000" as Address, relayer, caller: market, data, ciphertexts: [ciphertext, ciphertext] },
  };
}

test("market version defaults to v1 and accepts an explicit history start block", () => {
  const env = {
    RELAYER_CHAIN_ID: "11155111", RELAYER_RPC_URL: "http://127.0.0.1:8545", RELAYER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    RELAYER_POOL: contracts.pool, RELAYER_MARKET: contracts.market, RELAYER_MINT: contracts.mint, RELAYER_BUNDLE: contracts.bundle,
  };
  assert.equal(readConfig(env).contracts.marketVersion, 1);
  const configured = readConfig({ ...env, RELAYER_MARKET_VERSION: "2", RELAYER_MARKET_BLOCK: "123" });
  assert.equal(configured.contracts.marketVersion, 2);
  assert.equal(configured.marketBlock, 123n);
  assert.throws(() => readConfig({ ...env, RELAYER_MARKET_VERSION: "3" }), /must be 1 or 2/);
});

test("v2 fill binds pay while v1 rejects version probing through the body", () => {
  const fill = { orderId: "1", pay: "100", outInner: "2", outCiphertext: ciphertext };
  const data = keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes32" }],
    [1n, 100n, 2n, keccak256(ciphertext)],
  ));
  assert.match(prepareCall("/fill", { tx: tx(data), fill }, contracts).data, /^0x[0-9a-f]+$/);
  assert.throws(() => prepareCall("/fill", { tx: tx(data), fill }, { ...contracts, marketVersion: 1 }), /requires market v2/);
  assert.throws(() => prepareCall("/fill", { tx: tx(data), fill: { ...fill, pay: undefined } }, contracts), /fill pay/);
});

test("native sweep validates and hashes all arrays and output commitments", () => {
  const sweep = { orderIds: ["1", "2"], pays: ["40", "60"], minBought: "7", boughtInner: "8", boughtCiphertext: ciphertext, restInner: "9", restCiphertext: ciphertext };
  const data = keccak256(encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "uint64[]" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [[1n, 2n], [40n, 60n], 7n, 8n, keccak256(ciphertext), 9n, keccak256(ciphertext)],
  ));
  assert.match(prepareCall("/sweep", { tx: tx(data), sweep }, contracts).data, /^0x[0-9a-f]+$/);
  assert.throws(() => prepareCall("/sweep", { tx: tx(data), sweep: { ...sweep, orderIds: ["1", "1"] } }, contracts), /duplicate/);
  assert.throws(() => prepareCall("/sweep", { tx: tx(data), sweep }, { ...contracts, marketVersion: 1 }), /requires market v2/);
});

test("trade index keeps public fields, prices per 1000 TOKEN_ASSET, and only rescans the reorg window", async () => {
  let head = 200n;
  const ranges: Array<[bigint, bigint]> = [];
  const now = Math.floor(Date.now() / 1000);
  let reorgTimestamp = now - 30;
  const events: MarketEvent[] = [
    { kind: "placed", orderId: 1n, sellAsset: 0, block: 150n, logIndex: 1 },
    { kind: "filled", orderId: 1n, paid: 10_000_000n, bought: 100_000_000_000n, fee: 1_000_000n, block: 150n, logIndex: 2, tx: `0x${"ab".repeat(32)}` },
    { kind: "placed", orderId: 2n, sellAsset: 0, block: 195n, logIndex: 1 },
    { kind: "filled", orderId: 2n, paid: 10_000_000n, bought: 100_000_000_000n, fee: 1_000_000n, block: 195n, logIndex: 2, tx: `0x${"cd".repeat(32)}` },
  ];
  const source: TradeSource = {
    async blockNumber() { return head; },
    async marketEvents(from, to) { ranges.push([from, to]); return events.filter(event => event.block >= from && event.block <= to); },
    async blockTimestamp(block) { return block === 195n ? reorgTimestamp : now - 60; },
    async orderSellAsset() { return 0; },
  };
  const indexer = new TradeIndexer(source, 100n);
  const list = await indexer.list(0, 10);
  assert.deepEqual(list.trades.find(trade => trade.orderId === "1"), { orderId: "1", sellAsset: 0, paid: "10000000", bought: "100000000000", fee: "1000000", time: now - 60, tx: `0x${"ab".repeat(32)}`, block: "150", logIndex: 2 });
  const stats = await indexer.stats("1d");
  assert.equal(stats.last, "10000000");
  assert.equal(stats.points.length, 48);
  head = 201n;
  reorgTimestamp = now - 5;
  const rescanned = await indexer.list(0, 10);
  assert.deepEqual(ranges.at(-1), [189n, 201n]);
  assert.equal(rescanned.trades.find(trade => trade.orderId === "2")?.time, reorgTimestamp);

  head = 149n;
  const rolledBack = await indexer.list(0, 10);
  assert.equal(rolledBack.total, 0);
  assert.equal(rolledBack.indexedTo, "149");
  assert.deepEqual(ranges.at(-1), [138n, 149n]);

  head = 200n;
  assert.equal((await indexer.list(0, 10)).total, 2);
  head = 99n;
  const beforeDeployment = await indexer.list(0, 10);
  assert.equal(beforeDeployment.total, 0);
  assert.equal(beforeDeployment.indexedTo, "99");
});

test("trade history refuses an implicit genesis scan", async () => {
  const source: TradeSource = { async blockNumber() { return 1n; }, async marketEvents() { return []; }, async blockTimestamp() { return 0; }, async orderSellAsset() { return 0; } };
  await assert.rejects(new TradeIndexer(source).list(0, 1), /RELAYER_MARKET_BLOCK/);
});
