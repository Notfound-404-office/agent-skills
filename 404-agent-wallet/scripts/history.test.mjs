import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildHistory } from "./history.mjs";

const hash = digit => `0x${digit.repeat(64)}`;
const address = digit => `0x${digit.repeat(40)}`;
const pool = address("1");
const market = address("2");
const maker = address("3");

function fixture({ poolLogs = [], marketLogs = [], headHash = hash("a"), failWide = false } = {}) {
  const calls = [];
  const client = {
    async getLogs(request) {
      calls.push(request);
      if (failWide && request.toBlock - request.fromBlock + 1n > 2_500n) throw new Error("response size exceeded");
      const source = request.address === pool ? poolLogs : marketLogs;
      return source.filter(log => log.blockNumber >= request.fromBlock && log.blockNumber <= request.toBlock);
    },
    async getBlock({ blockNumber }) { return { number: blockNumber, hash: blockNumber === 10_100n ? headHash : hash("b"), timestamp: blockNumber + 1_000n }; },
  };
  return {
    calls,
    input: {
      root: fileURLToPath(new URL("../sdk", import.meta.url)),
      connection: { client, config: { deployBlock: 100n, contracts: { pool, market } } },
      snapshot: {
        head: { number: 10_100n, hash: hash("a"), timestamp: 0n },
        spent: new Set(),
        owned: [{ leafIndex: 7, nf: 77n, note: { asset: 0, value: 50n } }],
      },
      records: [], poolEvents: [], marketEvents: [],
      orderMaker: index => index === 4 ? maker : address("f"),
    },
  };
}

test("filters other wallets and recovers owned note history without a journal", async () => {
  const ownTx = hash("1");
  const spendTx = hash("9");
  const otherTx = hash("2");
  const { input } = fixture({ poolLogs: [
    { eventName: "NoteAdded", args: { leafIndex: 7n }, transactionHash: ownTx, blockNumber: 200n, logIndex: 0 },
    { eventName: "NoteAdded", args: { leafIndex: 8n }, transactionHash: otherTx, blockNumber: 201n, logIndex: 0 },
    { eventName: "Nullified", args: { nullifier: 77n }, transactionHash: spendTx, blockNumber: 202n, logIndex: 0 },
  ] });
  input.snapshot.spent.add(77n);
  const result = await buildHistory(input);
  assert.equal(result.total, 2);
  assert.equal(result.transactions[0].operation, "unknown");
  assert.deepEqual(result.transactions.find(item => item.txHash === ownTx).noteFlow.token, { received: "50", spent: "0", net: "50" });
  assert.deepEqual(result.transactions.find(item => item.txHash === spendTx).noteFlow.token, { received: "0", spent: "50", net: "-50" });
  assert.equal(result.transactions.some(item => item.txHash === otherTx), false);
});

test("includes passive fills only for deterministically owned orders and redacts journal internals", async () => {
  const placedTx = hash("3");
  const fillTx = hash("4");
  const { input } = fixture({ marketLogs: [
    { eventName: "OrderPlaced", args: { orderId: 9n, maker, sellAsset: 0, sellAmount: 10n, buyAmount: 20n }, transactionHash: placedTx, blockNumber: 300n, logIndex: 0 },
    { eventName: "OrderFilled", args: { orderId: 9n, paid: 4n, bought: 2n, shielded: true }, transactionHash: fillTx, blockNumber: 301n, logIndex: 0 },
    { eventName: "OrderFilled", args: { orderId: 10n, paid: 5n, bought: 3n, fee: 1n, shielded: true }, transactionHash: hash("5"), blockNumber: 302n, logIndex: 0 },
  ] });
  input.snapshot.owned = [];
  input.records = [{ id: "local", createdAt: 1, status: "submitted", txHash: placedTx, intent: { kind: "place", asset: "0", secret: "no" }, body: { proof: "no" }, authorization: "no" }];
  const result = await buildHistory(input);
  assert.equal(result.total, 2);
  assert.equal(result.transactions.find(item => item.txHash === fillTx).operation, "OrderFilled");
  assert.equal(result.transactions.find(item => item.txHash === fillTx).orderEvents[0].fee, null); // V1 has no fee event field.
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("proof"), false);
  assert.equal(serialized.includes("authorization"), false);
});

test("shrinks log windows, reads the full range, then paginates only the result", async () => {
  const { input, calls } = fixture({ failWide: true, poolLogs: [
    { eventName: "NoteAdded", args: { leafIndex: 7n }, transactionHash: hash("6"), blockNumber: 10_000n, logIndex: 0 },
    { eventName: "NoteAdded", args: { leafIndex: 8n }, transactionHash: hash("7"), blockNumber: 10_001n, logIndex: 0 },
  ] });
  input.snapshot.owned.push({ leafIndex: 8, nf: 88n, note: { asset: 1, value: 25n } });
  const result = await buildHistory(input, { offset: 0, limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.coverage.fromBlock, "100");
  assert.equal(result.coverage.toBlock, "10100");
  assert.ok(calls.some(call => call.fromBlock === 100n && call.toBlock === 5_099n));
  assert.ok(calls.some(call => call.fromBlock === 100n && call.toBlock === 2_599n));
  assert.ok(calls.some(call => call.toBlock === 10_100n));
});

test("rejects a reorganization instead of returning partial history", async () => {
  const { input } = fixture({ headHash: hash("e") });
  input.snapshot.owned = [];
  await assert.rejects(() => buildHistory(input), /reorganized/);
});

test("aggregates multiple owned notes in one transaction and ignores non-order market events", async () => {
  const tx = hash("8");
  const { input } = fixture({ poolLogs: [
    { eventName: "NoteAdded", args: { leafIndex: 7n, commitment: 700n }, transactionHash: tx, blockNumber: 400n, logIndex: 0 },
    { eventName: "NoteAdded", args: { leafIndex: 8n, commitment: 800n }, transactionHash: tx, blockNumber: 400n, logIndex: 1 },
  ], marketLogs: [
    { eventName: "EIP712DomainChanged", args: {}, transactionHash: tx, blockNumber: 400n, logIndex: 2 },
  ] });
  input.snapshot.owned = [
    { leafIndex: 7, cm: 700n, nf: 77n, note: { asset: 0, value: 50n } },
    { leafIndex: 8, cm: 800n, nf: 88n, note: { asset: 0, value: 25n } },
  ];
  const result = await buildHistory(input);
  assert.equal(result.total, 1);
  assert.deepEqual(result.transactions[0].noteFlow.token, { received: "75", spent: "0", net: "75" });
  assert.equal(result.transactions[0].orderEvents, undefined);
});
