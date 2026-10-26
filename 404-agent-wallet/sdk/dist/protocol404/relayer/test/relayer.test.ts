import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { encodeAbiParameters, keccak256, parseTransaction, type Address, type Hex } from "viem";
import { protocol404BundleAbi, protocol404MarketAbi, protocol404MarketV2Abi, protocol404MintAbi, protocol404PoolAbi } from "../src/abi.js";
import { prepareCall, type Contracts } from "../src/calls.js";
import { createChain } from "../src/chain.js";
import { readConfig, SIGNING_DOMAINS } from "../src/config.js";
import { createRelayerServer } from "../src/http.js";
import { RelayServicePool } from "../src/pool.js";
import { ConcurrencyGate, HttpError, RelayService, ReservationBook, type ChainAdapter } from "../src/service.js";
import { FIELD_MODULUS, validateTransaction } from "../src/validators.js";

const relayer = "0x1111111111111111111111111111111111111111" as Address;
const contracts: Contracts = {
  pool: "0x2222222222222222222222222222222222222222",
  market: "0x4444444444444444444444444444444444444444",
  mint: "0x5555555555555555555555555555555555555555",
  bundle: "0x6666666666666666666666666666666666666666",
};
const ciphertext = `0x${"00".repeat(175)}` as Hex;

function transaction(overrides: { fee?: string; root?: string; caller?: Address; nullifier?: string; asset?: string; relayer?: Address; data?: Hex } = {}) {
  return {
    proof: "0x" as Hex,
    pub: {
      root: overrides.root ?? "1",
      nullifiers: [overrides.nullifier ?? "2", "0"],
      commitments: ["3", "4"],
      nowTs: "5",
      asset: overrides.asset ?? "0",
      publicOut: "0",
      fee: overrides.fee ?? "1000000000",
    },
    ext: {
      recipient: "0x0000000000000000000000000000000000000000" as Address,
      relayer: overrides.relayer ?? relayer,
      caller: overrides.caller ?? "0x0000000000000000000000000000000000000000" as Address,
      data: overrides.data ?? `0x${"00".repeat(32)}` as Hex,
      ciphertexts: [ciphertext, ciphertext],
    },
  };
}

function release(action: 0 | 1, fee: string, overrides: { relayer?: Address; signatureByte?: string } = {}) {
  return { action, release: { orderId: "1", inner: "2", ciphertext, relayer: overrides.relayer ?? relayer, fee, deadline: "3" }, signature: `0x${(overrides.signatureByte ?? "11").repeat(65)}` };
}

function bundledRelease(action: 0 | 1, nullifier: string, signatureByte: string) {
  const signed = release(action, "0", { relayer: "0x0000000000000000000000000000000000000000", signatureByte });
  const nested = prepareCall("/release", signed, contracts);
  const data = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [nested.to, keccak256(nested.data)]));
  return {
    fee: transaction({ caller: contracts.bundle, asset: "1", fee: "10000", nullifier, data }),
    action: { kind: "release", release: signed },
  };
}

function service(chain: ChainAdapter, maxConcurrent = 2): RelayService {
  return new RelayService({ chainId: 56, relayer, contracts, fees: [1_000_000_000n, 10_000n], gasCap: 12_000_000n, maxConcurrent, reservationMs: 500 }, chain);
}

const configEnv = {
  RELAYER_CHAIN_ID: "56",
  RELAYER_RPC_URL: "http://127.0.0.1:8545",
  RELAYER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  RELAYER_POOL: contracts.pool,
  RELAYER_MARKET: contracts.market,
  RELAYER_MINT: contracts.mint,
  RELAYER_BUNDLE: contracts.bundle,
};

function testServer(corsOrigin?: string): Server {
  const chain: ChainAdapter = {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() {},
    async estimateGas() { return 1n; },
    async send() { return `0x${"ab".repeat(32)}`; },
  };
  return createRelayerServer(service(chain), 262_144, corsOrigin);
}

async function httpRequest(server: Server, method: string, path: string, headers: Record<string, string> = {}, requestBody?: unknown) {
  const input = requestBody === undefined ? [] : [JSON.stringify(requestBody)];
  const request = Object.assign(Readable.from(input), { method, url: path, headers }) as IncomingMessage;
  const responseHeaders = new Map<string, string>();
  return new Promise<{ status: number; headers: Map<string, string>; body: string }>(resolve => {
    let status = 0;
    const response = {
      setHeader(name: string, value: string) { responseHeaders.set(name.toLowerCase(), value); },
      writeHead(code: number, values: Record<string, string | number>) {
        status = code;
        for (const [name, value] of Object.entries(values)) responseHeaders.set(name.toLowerCase(), String(value));
      },
      end(value = "") { resolve({ status, headers: responseHeaders, body: String(value) }); },
    } as unknown as ServerResponse;
    server.emit("request", request, response);
  });
}

test("CORS origin config accepts only a bare HTTP(S) origin", () => {
  assert.equal(readConfig({ ...configEnv, RELAYER_CORS_ORIGIN: "http://127.0.0.1:4173" }).corsOrigin, "http://127.0.0.1:4173");
  assert.equal(readConfig(configEnv).corsOrigin, undefined);
  for (const value of ["*", "ftp://127.0.0.1", "http://user@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1/?x=1", "http://127.0.0.1/#x"]) {
    assert.throws(() => readConfig({ ...configEnv, RELAYER_CORS_ORIGIN: value }), /invalid RELAYER_CORS_ORIGIN/);
  }
});

test("Sepolia is accepted as an ETH testnet chain", () => {
  const config = readConfig({ ...configEnv, RELAYER_CHAIN_ID: "11155111" });
  assert.equal(config.chainId, 11155111);
  assert.equal(config.feeMode, "gas-plus");
});

test("signing profiles default to 404 and normalize explicit predecessor profiles", () => {
  const protocol404 = readConfig(configEnv);
  assert.deepEqual(protocol404.signingProfiles, { pool: "404", market: "404" });
  assert.deepEqual(SIGNING_DOMAINS[protocol404.signingProfiles.pool].pool, { name: "404", version: "2" });
  assert.deepEqual(SIGNING_DOMAINS[protocol404.signingProfiles.market].market, { name: "404 Market", version: "1" });

  const legacy = readConfig({ ...configEnv, RELAYER_POOL_PROFILE: "legacy-v1", RELAYER_MARKET_PROFILE: "legacy-v1" });
  assert.deepEqual(legacy.signingProfiles, { pool: "legacy-v1", market: "legacy-v1" });
  assert.deepEqual(SIGNING_DOMAINS[legacy.signingProfiles.pool].pool, { name: "BigWall", version: "2" });
  assert.deepEqual(SIGNING_DOMAINS[legacy.signingProfiles.market].market, { name: "BigWall Market", version: "1" });

  assert.deepEqual(readConfig({ ...configEnv, RELAYER_POOL_PROFILE: "bigwall-legacy", RELAYER_MARKET_PROFILE: "404" }).signingProfiles, {
    pool: "legacy-v1", market: "404",
  });
  assert.throws(() => readConfig({ ...configEnv, RELAYER_POOL_PROFILE: "shield-x" }), /RELAYER_POOL_PROFILE must be 404 or legacy-v1/);
  assert.throws(() => readConfig({ ...configEnv, RELAYER_MARKET_PROFILE: "custom" }), /RELAYER_MARKET_PROFILE must be 404 or legacy-v1/);
});

test("canonical 404 ABI exports retain required callable surfaces", () => {
  assert.ok(protocol404MarketAbi.some(entry => entry.type === "function" && entry.name === "placeOrder"));
  assert.ok(protocol404MarketV2Abi.some(entry => entry.type === "function" && entry.name === "sweepPrivate"));
  assert.ok(protocol404MintAbi.some(entry => entry.type === "function" && entry.name === "privateMint"));
  const transact = protocol404PoolAbi.find(entry => entry.type === "function" && entry.name === "transact") as any;
  assert.equal(transact.inputs[1].components.find((component: any) => component.name === "asset").type, "uint32");
  assert.ok(protocol404PoolAbi.some(entry => entry.type === "function" && entry.name === "ASSET_ID_BITS"));
  assert.ok(protocol404BundleAbi.some(entry => entry.type === "function" && entry.name === "relay"));
});

test("private-key arrays support a bounded deduplicated pool and preserve the single-key config", () => {
  const keys = Array.from({ length: 13 }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`);
  const pooled = readConfig({ ...configEnv, RELAYER_PRIVATE_KEYS: JSON.stringify([...keys, keys[0]]) });
  assert.deepEqual(pooled.privateKeys, keys);
  assert.equal(pooled.privateKey, keys[0]);
  assert.deepEqual(readConfig(configEnv).privateKeys, [configEnv.RELAYER_PRIVATE_KEY]);
  assert.throws(() => readConfig({ ...configEnv, RELAYER_PRIVATE_KEYS: JSON.stringify(Array(33).fill(keys[0])) }), /invalid RELAYER_PRIVATE_KEYS/);
  const secret = "not-a-private-key";
  assert.throws(() => readConfig({ ...configEnv, RELAYER_PRIVATE_KEYS: JSON.stringify([secret]) }), error => error instanceof Error && !error.message.includes(secret));
});

test("configured origin can quote, preflight, and POST while other origins cannot read responses", async () => {
  const origin = "http://127.0.0.1:4173";
  const server = testServer(origin);
  try {
    const quote = await httpRequest(server, "GET", "/quote", { origin });
    assert.equal(quote.status, 200);
    assert.equal(quote.headers.get("access-control-allow-origin"), origin);
    assert.equal(quote.headers.get("vary"), "Origin");

    const preflight = await httpRequest(server, "OPTIONS", "/relay", { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");

    const post = await httpRequest(server, "POST", "/relay", { origin, "content-type": "application/json" }, transaction());
    assert.equal(post.status, 200);
    assert.equal(post.headers.get("access-control-allow-origin"), origin);

    const rejected = await httpRequest(server, "POST", "/relay", { origin, "content-type": "application/json" }, transaction({ fee: "1" }));
    assert.equal(rejected.status, 400);
    assert.equal(JSON.parse(rejected.body).notBroadcast, true);

    const denied = await httpRequest(server, "GET", "/quote", { origin: "http://localhost:4173" });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get("access-control-allow-origin"), undefined);
    const deniedPreflight = await httpRequest(server, "OPTIONS", "/relay", { origin: "http://localhost:4173" });
    assert.equal(deniedPreflight.status, 404);
    assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), undefined);
  } finally { server.close(); }
});

test("CORS remains disabled by default", async () => {
  const server = testServer();
  try {
    const response = await httpRequest(server, "GET", "/quote", { origin: "http://127.0.0.1:4173" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), undefined);
  } finally { server.close(); }
});

test("original transaction validator and ABI call accept a valid payload", () => {
  const value = transaction();
  assert.deepEqual(validateTransaction(value).pub.nullifiers, ["2", "0"]);
  const call = prepareCall("/relay", value, contracts);
  assert.equal(call.to, contracts.pool);
  assert.match(call.data, /^0x[0-9a-f]+$/i);
});

test("validator rejects a field element at the BN254 modulus", () => {
  assert.throws(() => validateTransaction(transaction({ root: FIELD_MODULUS.toString() })), /bad request: field element/);
});

test("validator rejects malformed ciphertexts and assets outside uint32", () => {
  assert.throws(() => validateTransaction(transaction({ asset: (1n << 32n).toString() })), /uint32 range/);
  const value = transaction();
  value.ext.ciphertexts[0] = `0x${"00".repeat(174)}`;
  assert.throws(() => validateTransaction(value), /bad request: ciphertext/);
});

test("market-only POST endpoints ABI-encode without Swap routes", () => {
  const release = { action: 0, release: { orderId: "1", inner: "2", ciphertext, relayer, fee: "1000000000", deadline: "3" }, signature: `0x${"11".repeat(65)}` };
  const place = { buyAmount: "1", maker: relayer };
  const placeHash = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [1n, relayer]));
  const fill = { orderId: "1", outInner: "2", outCiphertext: ciphertext };
  const fillHash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [1n, 2n, keccak256(ciphertext)]));
  const mintHash = keccak256(encodeAbiParameters([{ type: "uint256[]" }, { type: "bytes32[]" }], [[1n], [keccak256(ciphertext)]]));
  const bundledTx = transaction({ fee: "0", relayer: "0x0000000000000000000000000000000000000000", nullifier: "9" });
  const nested = prepareCall("/relay", bundledTx, contracts);
  const bundleHash = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [nested.to, keccak256(nested.data)]));
  const values: Array<[string, unknown]> = [
    ["/order", { tx: transaction({ caller: contracts.market, data: placeHash }), place }],
    ["/fill", { tx: transaction({ caller: contracts.market, data: fillHash }), fill }],
    ["/mint", { tx: transaction({ caller: contracts.mint, asset: "1", fee: "10000", data: mintHash }), mint: { inners: ["1"], ciphertexts: [ciphertext] } }],
    ["/release", release],
    ["/bundle", {
      fee: transaction({ caller: contracts.bundle, asset: "1", fee: "10000", data: bundleHash }),
      action: { kind: "transact", tx: bundledTx },
    }],
  ];
  for (const [path, value] of values) assert.match(prepareCall(path, value, contracts).data, /^0x[0-9a-f]+$/i, path);
});

test("service performs call and estimate before broadcasting", async () => {
  const events: string[] = [];
  const chain: ChainAdapter = {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() { events.push("call"); },
    async estimateGas() { events.push("estimate"); return 1_000_000n; },
    async send(request) { events.push(`send:${request.gas}`); return `0x${"ab".repeat(32)}`; },
  };
  const result = await service(chain).submit("/relay", transaction());
  assert.deepEqual(events, ["call", "estimate", "send:1200000"]);
  assert.equal(result.txHash, `0x${"ab".repeat(32)}`);
});

test("bad fee and failed simulation never broadcast", async () => {
  let sends = 0;
  const chain: ChainAdapter = {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() { throw new Error("reverted"); },
    async estimateGas() { return 1n; },
    async send() { sends++; return `0x${"ab".repeat(32)}`; },
  };
  await assert.rejects(service(chain).submit("/relay", transaction({ fee: "1" })), /bad request: fee/);
  await assert.rejects(service(chain).submit("/relay", transaction()), /reverted/);
  assert.equal(sends, 0);
});

test("HTTP 500 responses do not expose upstream error details", async () => {
  const secret = "http://rpc.local/private-token";
  const chain: ChainAdapter = {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() { throw new Error(`RPC request failed at ${secret}`); },
    async estimateGas() { return 1n; },
    async send() { return `0x${"ab".repeat(32)}`; },
  };
  const server = createRelayerServer(service(chain), 262_144);
  try {
    const response = await httpRequest(server, "POST", "/relay", { "content-type": "application/json" }, transaction());
    assert.equal(response.status, 500);
    assert.equal(response.body.includes(secret), false);
  } finally { server.close(); }
});

test("send errors are always unknown 500 results without notBroadcast", async () => {
  for (const failure of [new Error("bad request: upstream"), new HttpError(400, "bad request: upstream")]) {
    const chain: ChainAdapter = {
      async readOrder() { return { sellAsset: 0, releases: 0 }; },
      async call() {},
      async estimateGas() { return 1n; },
      async send() { throw failure; },
    };
    const server = createRelayerServer(service(chain), 262_144);
    try {
      const response = await httpRequest(server, "POST", "/relay", { "content-type": "application/json" }, transaction());
      assert.equal(response.status, 500);
      assert.equal(JSON.parse(response.body).notBroadcast, undefined);
    } finally { server.close(); }
  }

  const server = testServer();
  try {
    const invalid = await httpRequest(server, "POST", "/relay", { "content-type": "application/json" }, transaction({ root: FIELD_MODULUS.toString() }));
    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(invalid.body).notBroadcast, true);
  } finally { server.close(); }
});

test("chain RPC errors redact the configured URL and discard the cause", async () => {
  let rpcUrl = "";
  const rpc = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `failed at ${rpcUrl}` } }));
  });
  await new Promise<void>(resolve => rpc.listen(0, "127.0.0.1", resolve));
  try {
    const address = rpc.address();
    assert(address && typeof address === "object");
    rpcUrl = `http://127.0.0.1:${address.port}/private-token`;
    const config = readConfig({ ...configEnv, RELAYER_RPC_URL: rpcUrl });
    const chain = createChain(config);
    await assert.rejects(chain.adapter.call({ account: relayer, to: contracts.pool, data: "0x" }), error => {
      return error instanceof Error && !error.message.includes(rpcUrl) && !("cause" in error);
    });
  } finally { await new Promise<void>(resolve => rpc.close(() => resolve())); }
});

test("Sepolia send signs with 5 gwei max and 1 gwei priority fee floors", async () => {
  let rawTransaction: Hex | undefined;
  const blockHash = `0x${"12".repeat(32)}`;
  const rpc = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
    if (payload.method === "eth_fillTransaction") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: "method not found" } }));
    }
    let result: unknown;
    if (payload.method === "eth_getBlockByNumber") result = {
      number: "0x1", hash: blockHash, parentHash: blockHash, nonce: "0x0000000000000000",
      sha3Uncles: blockHash, logsBloom: `0x${"00".repeat(256)}`, transactionsRoot: blockHash,
      stateRoot: blockHash, receiptsRoot: blockHash, miner: "0x0000000000000000000000000000000000000000",
      difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1",
      gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", transactions: [], uncles: [],
      baseFeePerGas: "0xa", mixHash: blockHash,
    };
    else if (payload.method === "eth_maxPriorityFeePerGas") result = "0x2";
    else if (payload.method === "eth_getTransactionCount") result = "0x0";
    else if (payload.method === "eth_sendRawTransaction") {
      rawTransaction = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { params: [Hex] }).params[0];
      result = `0x${"ab".repeat(32)}`;
    } else if (payload.method === "eth_chainId") result = "0xaa36a7";
    else throw new Error(`unexpected RPC method ${payload.method}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
  });
  await new Promise<void>(resolve => rpc.listen(0, "127.0.0.1", resolve));
  try {
    const address = rpc.address();
    assert(address && typeof address === "object");
    const config = readConfig({ ...configEnv, RELAYER_CHAIN_ID: "11155111", RELAYER_RPC_URL: `http://127.0.0.1:${address.port}` });
    const chain = createChain(config);
    await chain.adapter.send({ account: chain.relayer, to: contracts.pool, data: "0x", gas: 21_000n });
    assert(rawTransaction);
    const signed = parseTransaction(rawTransaction);
    assert.equal(signed.maxFeePerGas, 5_000_000_000n);
    assert.equal(signed.maxPriorityFeePerGas, 1_000_000_000n);
  } finally { await new Promise<void>(resolve => rpc.close(() => resolve())); }
});

test("direct release fee follows the order asset and action", async () => {
  let sends = 0;
  let sellAsset = 0;
  let releases = 0;
  const chain = {
    async readOrder() { return { sellAsset, releases }; },
    async call() {},
    async estimateGas() { return 1n; },
    async send() { sends++; releases++; return `0x${"ab".repeat(32)}` as Hex; },
  };
  const relay = service(chain);
  await assert.rejects(relay.submit("/release", release(0, "1000000000")), /bad request: fee/);
  await relay.submit("/release", release(0, "10000"));
  await relay.submit("/release", release(1, "1000000000"));
  sellAsset = 1;
  await relay.submit("/release", release(0, "1000000000"));
  await relay.submit("/release", release(1, "10000"));
  assert.equal(sends, 4);
});

test("different direct release payloads for the same order nonce conflict", async () => {
  let unblock: (() => void) | undefined;
  let calls = 0;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const chain = {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() { if (++calls === 1) await blocked; },
    async estimateGas() { return 1n; },
    async send() { return `0x${"ab".repeat(32)}` as Hex; },
  };
  const relay = service(chain);
  const first = relay.submit("/release", release(1, "1000000000"));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(relay.submit("/release", release(0, "10000", { signatureByte: "22" })), error => error instanceof HttpError && error.status === 409);
  unblock?.();
  await first;
  assert.equal(calls, 1);
});

test("bundled releases with different fee nullifiers conflict on the order nonce", async () => {
  let unblock: (() => void) | undefined;
  let calls = 0;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const chain: ChainAdapter = {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() { if (++calls === 1) await blocked; },
    async estimateGas() { return 1n; },
    async send() { return `0x${"ab".repeat(32)}`; },
  };
  const relay = service(chain);
  const first = relay.submit("/bundle", bundledRelease(0, "91", "33"));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(relay.submit("/bundle", bundledRelease(1, "92", "44")), error => error instanceof HttpError && error.status === 409);
  unblock?.();
  await first;
  assert.equal(calls, 1);
});

test("a stale reservation release cannot delete a newer reservation", () => {
  const book = new ReservationBook();
  const staleRelease = book.reserve(["release:1:0"], 1_000);
  staleRelease();
  const currentRelease = book.reserve(["release:1:0"], 1_000);
  staleRelease();
  assert.throws(() => book.reserve(["release:1:0"], 1_000), error => error instanceof HttpError && error.status === 409);
  currentRelease();
});

test("a failed direct release frees its canonical reservation", async () => {
  let calls = 0;
  const chain = {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() { if (++calls === 1) throw new Error("reverted"); },
    async estimateGas() { return 1n; },
    async send() { return `0x${"ab".repeat(32)}` as Hex; },
  };
  const relay = service(chain);
  await assert.rejects(relay.submit("/release", release(1, "1000000000")), /reverted/);
  await relay.submit("/release", release(1, "1000000000"));
  assert.equal(calls, 2);
});

test("delayed release fee reads cannot race past the concurrency limit", async () => {
  let unblockReads: (() => void) | undefined;
  let unblockCall: (() => void) | undefined;
  let calls = 0;
  const readsBlocked = new Promise<void>(resolve => { unblockReads = resolve; });
  const callBlocked = new Promise<void>(resolve => { unblockCall = resolve; });
  const chain: ChainAdapter = {
    async readOrder() { await readsBlocked; return { sellAsset: 0, releases: 0 }; },
    async call() { calls++; await callBlocked; },
    async estimateGas() { return 1n; },
    async send() { return `0x${"ab".repeat(32)}`; },
  };
  const relay = service(chain, 1);
  const outcomes: Array<number | "sent"> = [];
  const first = relay.submit("/release", release(0, "10000")).then(() => outcomes.push("sent"), error => outcomes.push(error instanceof HttpError ? error.status : 0));
  const second = relay.submit("/release", release(1, "1000000000")).then(() => outcomes.push("sent"), error => outcomes.push(error instanceof HttpError ? error.status : 0));
  unblockReads?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(outcomes, [503]);
  unblockCall?.();
  await Promise.all([first, second]);
  assert.deepEqual(outcomes.sort(), [503, "sent"].sort());
});

test("an in-flight nullifier is rejected with 409", async () => {
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const chain: ChainAdapter = {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() { await blocked; },
    async estimateGas() { return 1n; },
    async send() { return `0x${"ab".repeat(32)}`; },
  };
  const relay = service(chain);
  const first = relay.submit("/relay", transaction());
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(relay.submit("/relay", transaction()), error => error instanceof HttpError && error.status === 409);
  unblock?.();
  await first;
});

test("unknown broadcast results keep nullifier and release reservations", async () => {
  const chain: ChainAdapter = {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() {},
    async estimateGas() { return 1n; },
    async send() { throw new Error("response lost"); },
  };
  const relay = service(chain);
  await assert.rejects(relay.submit("/relay", transaction()), /broadcast outcome unknown/);
  await assert.rejects(relay.submit("/relay", transaction()), error => error instanceof HttpError && error.status === 409);

  await assert.rejects(relay.submit("/release", release(0, "10000")), /broadcast outcome unknown/);
  await assert.rejects(relay.submit("/release", release(1, "1000000000", { signatureByte: "22" })), error => error instanceof HttpError && error.status === 409);
});

function relayPool(maxConcurrent = 4, block?: Promise<void>) {
  const relayers = Array.from({ length: 13 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}` as Address);
  const sends = Array(13).fill(0) as number[];
  const reservations = new ReservationBook();
  const concurrency = new ConcurrencyGate(maxConcurrent);
  const services = relayers.map((address, index) => new RelayService({
    chainId: 56, relayer: address, contracts, fees: [1_000_000_000n, 10_000n], gasCap: 12_000_000n,
    maxConcurrent, reservationMs: 500,
  }, {
    async readOrder() { return { sellAsset: 0, releases: 0 }; },
    async call() { if (block) await block; },
    async estimateGas() { return 1n; },
    async send() { sends[index]++; return `0x${"ab".repeat(32)}`; },
  }, reservations, concurrency));
  return { pool: new RelayServicePool(services, contracts), relayers, sends };
}

test("13-wallet quotes rotate publicly while submissions remain bound to the signed quote", async () => {
  const { pool, relayers, sends } = relayPool();
  const quotes = await Promise.all(Array.from({ length: 13 }, () => pool.quote()));
  assert.deepEqual(quotes.map(quote => quote.relayer), relayers);
  assert.deepEqual(quotes[0].relayers, relayers);
  assert.equal(quotes[0].relayerCount, 13);
  assert.equal(JSON.stringify(quotes).includes("privateKey"), false);
  await pool.quote();
  await pool.submit("/relay", transaction({ relayer: quotes[0].relayer }));
  assert.deepEqual(sends, [1, ...Array(12).fill(0)]);
  await assert.rejects(pool.submit("/relay", transaction({ relayer: "0xffffffffffffffffffffffffffffffffffffffff" })), error => error instanceof HttpError && error.status === 400);
});

test("wallet pool shares nullifier and order reservations across senders", async () => {
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const { pool, relayers } = relayPool(4, blocked);
  const first = pool.submit("/relay", transaction({ relayer: relayers[0], nullifier: "71" }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(pool.submit("/relay", transaction({ relayer: relayers[1], nullifier: "71" })), error => error instanceof HttpError && error.status === 409);
  unblock?.();
  await first;

  let unblockRelease: (() => void) | undefined;
  const releaseBlocked = new Promise<void>(resolve => { unblockRelease = resolve; });
  const secondPool = relayPool(4, releaseBlocked);
  const releaseFirst = secondPool.pool.submit("/release", release(1, "1000000000", { relayer: secondPool.relayers[0] }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(secondPool.pool.submit("/release", release(0, "10000", { relayer: secondPool.relayers[1], signatureByte: "22" })), error => error instanceof HttpError && error.status === 409);
  unblockRelease?.();
  await releaseFirst;
});

test("wallet pool keeps maxConcurrent as one process-wide limit", async () => {
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const { pool, relayers } = relayPool(1, blocked);
  const first = pool.submit("/relay", transaction({ relayer: relayers[0], nullifier: "81" }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(pool.submit("/relay", transaction({ relayer: relayers[1], nullifier: "82" })), error => error instanceof HttpError && error.status === 503);
  unblock?.();
  await first;
});
