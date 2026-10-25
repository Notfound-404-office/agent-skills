import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createPublicClient, defineChain, getAddress, http, isAddress, isHex, parseAbiItem,
  type Address, type Hex,
} from "viem";
import { PoolIndexer, type PoolAnchor, type PoolEvent, type PoolSource } from "./pool-indexer.js";
import { PoolStore } from "./pool-store.js";
import { HttpError } from "./service.js";
import { TradeIndexer, type MarketEvent, type TradeSource } from "./trades.js";

const orderPlacedEvent = parseAbiItem("event OrderPlaced(uint256 indexed orderId,address indexed maker,uint32 sellAsset,uint64 sellAmount,uint64 buyAmount)");
const orderFilledV1Event = parseAbiItem("event OrderFilled(uint256 indexed orderId,uint64 paid,uint64 bought,bool shielded)");
const orderFilledV2Event = parseAbiItem("event OrderFilled(uint256 indexed orderId,uint64 paid,uint64 bought,uint64 fee,bool shielded)");
const poolAbi = [{ type: "function", name: "pool", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;
const assetIdBitsAbi = [{ type: "function", name: "ASSET_ID_BITS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
const ordersAbi = [{
  type: "function", name: "orders", stateMutability: "view",
  inputs: [{ name: "orderId", type: "uint256" }],
  outputs: [{ name: "", type: "tuple", components: [
    { name: "sellAsset", type: "uint32" }, { name: "open", type: "bool" },
    { name: "releases", type: "uint32" }, { name: "maker", type: "address" },
    { name: "sellAmount", type: "uint64" }, { name: "buyAmount", type: "uint64" },
    { name: "remaining", type: "uint64" }, { name: "proceeds", type: "uint64" },
  ] }],
}] as const;
const poolEvents = [
  parseAbiItem("event NoteAdded(uint256 indexed leafIndex,uint256 commitment,bytes ciphertext)"),
  parseAbiItem("event Shielded(address indexed from,uint256 indexed leafIndex,uint32 asset,uint256 amount)"),
  parseAbiItem("event Nullified(uint256 indexed nullifier)"),
  parseAbiItem("event Transacted(bytes32 indexed requestDigest)"),
] as const;
const poolStateAbi = [
  { type: "function", name: "currentRoot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextIndex", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nullifierCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nullifierDigest", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "transactionDigest", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

export type IndexerConfig = {
  host: string; port: number; rpcUrl: string; chainId: 56 | 97 | 11155111;
  pool: Address; market: Address; marketVersion: 1 | 2; marketBlock: bigint;
  poolBlock?: bigint; database?: string;
  corsOrigin?: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid INDEXER_RPC_URL"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("invalid INDEXER_RPC_URL");
  return value;
}

function origin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid INDEXER_CORS_ORIGIN"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("invalid INDEXER_CORS_ORIGIN");
  }
  return value.replace(/\/$/, "");
}

export function readIndexerConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const chainId = Number(required(env, "INDEXER_CHAIN_ID"));
  if (chainId !== 56 && chainId !== 97 && chainId !== 11155111) throw new Error("INDEXER_CHAIN_ID must be 56, 97 or 11155111");
  const port = Number(env.INDEXER_PORT ?? "8788");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid INDEXER_PORT");
  const marketVersion = Number(env.INDEXER_MARKET_VERSION ?? "1");
  if (marketVersion !== 1 && marketVersion !== 2) throw new Error("INDEXER_MARKET_VERSION must be 1 or 2");
  const marketBlockText = required(env, "INDEXER_MARKET_BLOCK");
  if (!/^\d+$/.test(marketBlockText)) throw new Error("INDEXER_MARKET_BLOCK must be a non-negative integer");
  const pool = required(env, "INDEXER_POOL");
  const market = required(env, "INDEXER_MARKET");
  if (!isAddress(pool) || !isAddress(market)) throw new Error("invalid indexer contract address");
  const poolBlockText = env.INDEXER_POOL_BLOCK;
  const database = env.INDEXER_DATABASE;
  if (Boolean(poolBlockText) !== Boolean(database)) throw new Error("INDEXER_POOL_BLOCK and INDEXER_DATABASE must be set together");
  if (poolBlockText && !/^\d+$/.test(poolBlockText)) throw new Error("INDEXER_POOL_BLOCK must be a non-negative integer");
  return {
    host: env.INDEXER_HOST ?? "127.0.0.1", port,
    rpcUrl: endpoint(required(env, "INDEXER_RPC_URL")), chainId,
    pool: getAddress(pool), market: getAddress(market), marketVersion,
    marketBlock: BigInt(marketBlockText), ...(poolBlockText && database ? { poolBlock: BigInt(poolBlockText), database } : {}),
    corsOrigin: origin(env.INDEXER_CORS_ORIGIN),
  };
}

export function createPublicTradeSource(config: IndexerConfig): { source: TradeSource; poolSource: PoolSource; verify(): Promise<void> } {
  const sepolia = config.chainId === 11155111;
  const chain = defineChain({
    id: config.chainId,
    name: sepolia ? "Sepolia" : config.chainId === 56 ? "BNB Smart Chain" : "BNB Smart Chain Testnet",
    nativeCurrency: { name: sepolia ? "Ether" : "BNB", symbol: sepolia ? "ETH" : "BNB", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } }, testnet: config.chainId !== 56,
  });
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 20_000 }), ccipRead: false });
  async function rpc<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replaceAll(config.rpcUrl, "[redacted RPC URL]"));
    }
  }
  const source: TradeSource = {
    blockNumber: () => rpc(() => publicClient.getBlockNumber()),
    async blockTimestamp(blockNumber) { return Number((await rpc(() => publicClient.getBlock({ blockNumber }))).timestamp); },
    async orderSellAsset(orderId, blockNumber) {
      const order = await rpc(() => publicClient.readContract({ address: config.market, abi: ordersAbi, functionName: "orders", args: [orderId], blockNumber }));
      return Number(order.sellAsset);
    },
    async marketEvents(fromBlock, toBlock) {
      const fillEvent = config.marketVersion === 2 ? orderFilledV2Event : orderFilledV1Event;
      const [placements, fills] = await rpc(() => Promise.all([
        publicClient.getLogs({ address: config.market, event: orderPlacedEvent, fromBlock, toBlock }),
        publicClient.getLogs({ address: config.market, event: fillEvent, fromBlock, toBlock }),
      ]));
      const events: MarketEvent[] = placements.map(log => ({
        kind: "placed", orderId: log.args.orderId!, sellAsset: Number(log.args.sellAsset!), block: log.blockNumber, logIndex: log.logIndex,
      }));
      for (const log of fills) {
        const args = log.args as { orderId?: bigint; paid?: bigint; bought?: bigint; fee?: bigint };
        events.push({ kind: "filled", orderId: args.orderId!, paid: args.paid!, bought: args.bought!, fee: args.fee ?? 0n, block: log.blockNumber, logIndex: log.logIndex, tx: log.transactionHash as Hex });
      }
      return events;
    },
  };
  const poolSource: PoolSource = {
    blockNumber: () => rpc(() => publicClient.getBlockNumber()),
    async block(blockNumber) {
      const block = await rpc(() => publicClient.getBlock({ blockNumber }));
      if (!block.hash) throw new Error("RPC returned a block without a hash");
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    async events(fromBlock, toBlock) {
      const logs = await rpc(() => publicClient.getLogs({ address: config.pool, events: poolEvents, fromBlock, toBlock, strict: true }));
      return logs.map(log => {
        const base = { block: log.blockNumber, logIndex: log.logIndex, tx: log.transactionHash };
        if (log.eventName === "NoteAdded") return { kind: "note", ...base, leafIndex: log.args.leafIndex, commitment: log.args.commitment, ciphertext: log.args.ciphertext };
        if (log.eventName === "Shielded") return { kind: "shielded", ...base, leafIndex: log.args.leafIndex, asset: Number(log.args.asset), value: log.args.amount };
        if (log.eventName === "Nullified") return { kind: "nullified", ...base, nullifier: log.args.nullifier };
        return { kind: "transacted", ...base, requestDigest: log.args.requestDigest };
      }) as PoolEvent[];
    },
    async state(blockNumber) {
      const [root, nextIndex, nullifierCount, nullifierDigest, transactionDigest] = await rpc(() => Promise.all([
        publicClient.readContract({ address: config.pool, abi: poolStateAbi, functionName: "currentRoot", blockNumber }),
        publicClient.readContract({ address: config.pool, abi: poolStateAbi, functionName: "nextIndex", blockNumber }),
        publicClient.readContract({ address: config.pool, abi: poolStateAbi, functionName: "nullifierCount", blockNumber }),
        publicClient.readContract({ address: config.pool, abi: poolStateAbi, functionName: "nullifierDigest", blockNumber }),
        publicClient.readContract({ address: config.pool, abi: poolStateAbi, functionName: "transactionDigest", blockNumber }),
      ]));
      return { root, nextIndex, nullifierCount, nullifierDigest, transactionDigest };
    },
  };
  return {
    source, poolSource,
    async verify() {
      await rpc(async () => {
        if (await publicClient.getChainId() !== config.chainId) throw new Error("RPC chain does not match INDEXER_CHAIN_ID");
        if (!await publicClient.getBytecode({ address: config.pool })) throw new Error("pool has no contract code");
        if (!await publicClient.getBytecode({ address: config.market })) throw new Error("market has no contract code");
        try {
          const bits = await publicClient.readContract({ address: config.pool, abi: assetIdBitsAbi, functionName: "ASSET_ID_BITS" });
          if (bits !== 32) throw new Error("wrong width");
        } catch {
          throw new Error("pool deployment is incompatible: ASSET_ID_BITS() must return 32; a new deployment is required");
        }
        const pool = await publicClient.readContract({ address: config.market, abi: poolAbi, functionName: "pool" });
        if (getAddress(pool) !== config.pool) throw new Error("market points to a different pool");
      });
    },
  };
}

type TradeReader = {
  list(offset: number, limit: number): Promise<unknown>;
  stats(range: "1d" | "7d" | "30d" | "all"): Promise<unknown>;
};
type PoolReader = Pick<PoolIndexer, "checkpoint" | "notes" | "path" | "spends" | "requests">;
type Health = { ok: true; type: "read-only"; chainId: number; pool: Address; market: Address; marketVersion: number; indexedFrom: string };

function decimal(value: string | null, name: string): bigint {
  if (value === null || !/^\d+$/.test(value)) throw new HttpError(400, `invalid ${name}`);
  return BigInt(value);
}

function anchor(url: URL): PoolAnchor {
  const hash = url.searchParams.get("hash");
  if (!hash || !isHex(hash, { strict: true }) || hash.length !== 66) throw new HttpError(400, "invalid hash");
  return { block: decimal(url.searchParams.get("block"), "block"), hash: hash.toLowerCase() as Hex };
}

export function createIndexerServer(indexer: TradeReader, health: Health, corsOrigin?: string, poolIndexer?: PoolReader): Server {
  return createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const requestOrigin = request.headers.origin;
    if (corsOrigin && requestOrigin === corsOrigin) { response.setHeader("Access-Control-Allow-Origin", corsOrigin); response.setHeader("Vary", "Origin"); }
    const send = (status: number, value: unknown) => { const body = JSON.stringify(value); response.writeHead(status, { "Content-Length": Buffer.byteLength(body) }); response.end(body); };
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET") { send(404, { error: "not found" }); return; }
      if (url.pathname === "/health") { send(200, health); return; }
      if (url.pathname === "/trades") {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid pagination");
        send(200, await indexer.list(offset, limit)); return;
      }
      if (url.pathname === "/trades/stats") {
        const range = url.searchParams.get("range") ?? "1d";
        if (range !== "1d" && range !== "7d" && range !== "30d" && range !== "all") throw new HttpError(400, "invalid range");
        send(200, await indexer.stats(range)); return;
      }
      if (url.pathname === "/pool/checkpoint" && poolIndexer) { send(200, await poolIndexer.checkpoint()); return; }
      if (url.pathname === "/pool/notes" && poolIndexer) {
        const limitText = url.searchParams.get("limit") ?? "256";
        if (!/^\d+$/.test(limitText)) throw new HttpError(400, "invalid limit");
        const fromBlock = url.searchParams.get("fromBlock");
        send(200, await poolIndexer.notes(anchor(url), decimal(url.searchParams.get("cursor") ?? "0", "cursor"), Number(limitText),
          fromBlock === null ? undefined : decimal(fromBlock, "fromBlock"))); return;
      }
      if (url.pathname === "/pool/path" && poolIndexer) {
        send(200, await poolIndexer.path(anchor(url), decimal(url.searchParams.get("leafIndex"), "leafIndex"))); return;
      }
      if (url.pathname === "/pool/spends" && poolIndexer) {
        const input = url.searchParams.get("nullifiers");
        if (!input) throw new HttpError(400, "invalid nullifiers");
        send(200, await poolIndexer.spends(anchor(url), input.split(",").map(value => decimal(value, "nullifier")))); return;
      }
      if (url.pathname === "/pool/requests" && poolIndexer) {
        const input = url.searchParams.get("digests");
        if (!input) throw new HttpError(400, "invalid request digests");
        send(200, await poolIndexer.requests(anchor(url), input.split(",") as Hex[])); return;
      }
      send(404, { error: "not found" });
    } catch (error) {
      if (error instanceof HttpError) send(error.status, { error: error.message });
      else send(500, { error: "indexer unavailable" });
    }
  });
}

async function main() {
  const config = readIndexerConfig();
  const chain = createPublicTradeSource(config);
  await chain.verify();
  const indexer = new TradeIndexer(chain.source, config.marketBlock);
  const poolIndexer = config.poolBlock !== undefined && config.database !== undefined
    ? new PoolIndexer(chain.poolSource, new PoolStore(config.database, { chainId: config.chainId, pool: config.pool, deployBlock: config.poolBlock }), config.poolBlock)
    : undefined;
  const server = createIndexerServer(indexer, {
    ok: true, type: "read-only", chainId: config.chainId, pool: config.pool, market: config.market,
    marketVersion: config.marketVersion, indexedFrom: String(config.marketBlock),
  }, config.corsOrigin, poolIndexer);
  server.listen(config.port, config.host, () => console.log(`read-only indexer listening on ${config.host}:${config.port}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(async () => {
    await poolIndexer?.close();
    process.exit(0);
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "indexer failed"); process.exitCode = 1; });
}
