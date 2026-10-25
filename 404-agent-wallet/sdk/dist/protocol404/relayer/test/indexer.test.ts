import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { createIndexerServer, readIndexerConfig } from "../src/indexer.js";

async function request(server: Server, method: string, path: string) {
  const input = Object.assign(Readable.from([]), { method, url: path, headers: {} }) as IncomingMessage;
  return new Promise<{ status: number; body: string }>(resolve => {
    let status = 0;
    const output = {
      setHeader() {},
      writeHead(code: number) { status = code; },
      end(body = "") { resolve({ status, body: String(body) }); },
    } as unknown as ServerResponse;
    server.emit("request", input, output);
  });
}

const health = {
  ok: true as const, type: "read-only" as const, chainId: 11155111,
  pool: "0x2222222222222222222222222222222222222222" as const,
  market: "0x4444444444444444444444444444444444444444" as const,
  marketVersion: 1, indexedFrom: "100",
};
const reader = {
  async list(offset: number, limit: number) { return { total: 0, offset, limit, trades: [] }; },
  async stats(range: "1d" | "7d" | "30d" | "all") { return { range, trades24h: 0 }; },
};

test("read-only server exposes only health and trade GET routes", async () => {
  const server = createIndexerServer(reader, health);
  const status = await request(server, "GET", "/health");
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), health);
  assert.equal((await request(server, "GET", "/trades?offset=2&limit=10")).status, 200);
  assert.equal((await request(server, "GET", "/trades/stats?range=7d")).status, 200);
  assert.equal((await request(server, "GET", "/quote")).status, 404);
  assert.equal((await request(server, "POST", "/trades")).status, 404);
});

test("public pool GET routes require pinned anchors and preserve the wire query", async () => {
  const checkpoint = { version: 1, chainId: 11155111, pool: health.pool, blockNumber: "100", blockHash: `0x${"11".repeat(32)}` as const, timestamp: "1", root: "2", nextIndex: "4", nullifierCount: "0", nullifierDigest: `0x${"00".repeat(32)}` as const, transactionDigest: `0x${"00".repeat(32)}` as const } as const;
  const calls: unknown[] = [];
  const poolReader = {
    async checkpoint() { return checkpoint; },
    async notes(anchor: unknown, cursor: bigint, limit: number, fromBlock?: bigint) { calls.push({ anchor, cursor, limit, fromBlock }); return { checkpoint, notes: [], nextCursor: "4", done: true }; },
    async path() { return { checkpoint, leafIndex: "0", commitment: "1", path: Array(32).fill("0") }; },
    async spends() { return { checkpoint, records: [] }; },
    async requests() { return { checkpoint, records: [] }; },
  };
  const server = createIndexerServer(reader, health, undefined, poolReader);
  assert.equal((await request(server, "GET", "/pool/checkpoint")).status, 200);
  const anchored = `/pool/notes?block=100&hash=${checkpoint.blockHash}&cursor=2&limit=3&fromBlock=90`;
  assert.equal((await request(server, "GET", anchored)).status, 200);
  assert.deepEqual(calls, [{ anchor: { block: 100n, hash: checkpoint.blockHash }, cursor: 2n, limit: 3, fromBlock: 90n }]);
  assert.equal((await request(server, "GET", "/pool/path?leafIndex=0")).status, 400);
});

test("indexer config needs public chain data only", () => {
  const config = readIndexerConfig({
    INDEXER_CHAIN_ID: "11155111", INDEXER_RPC_URL: "http://127.0.0.1:18547",
    INDEXER_POOL: health.pool, INDEXER_MARKET: health.market, INDEXER_MARKET_BLOCK: "100",
  });
  assert.equal(config.marketBlock, 100n);
  assert.equal("privateKey" in config, false);
  assert.equal(config.database, undefined);
  assert.throws(() => readIndexerConfig({
    INDEXER_CHAIN_ID: "11155111", INDEXER_RPC_URL: "http://127.0.0.1:18547",
    INDEXER_POOL: health.pool, INDEXER_MARKET: health.market, INDEXER_MARKET_BLOCK: "100", INDEXER_DATABASE: "index.sqlite",
  }), /must be set together/);
});
