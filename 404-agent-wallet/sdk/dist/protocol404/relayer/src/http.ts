import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RelayHandler } from "./pool.js";
import { HttpError } from "./service.js";

const POST_PATHS = new Set(["/relay", "/order", "/fill", "/sweep", "/mint", "/bundle", "/release"]);

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

function allowOrigin(request: IncomingMessage, response: ServerResponse, corsOrigin: string | undefined): boolean {
  if (corsOrigin === undefined || request.headers.origin !== corsOrigin) return false;
  response.setHeader("access-control-allow-origin", corsOrigin);
  response.setHeader("vary", "Origin");
  return true;
}

async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid JSON"); }
}

/** Native HTTP wrapper for the original relayer API paths. */
export function createRelayerServer(service: RelayHandler, bodyLimit: number, corsOrigin?: string): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://relayer.local");
      const path = url.pathname;
      const allowedOrigin = allowOrigin(request, response, corsOrigin);
      if (request.method === "OPTIONS" && allowedOrigin && POST_PATHS.has(path)) {
        response.writeHead(204, { "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" });
        return response.end();
      }
      if (request.method === "GET" && path === "/health") return json(response, 200, { ok: true, ...await service.quote() });
      if (request.method === "GET" && path === "/quote") return json(response, 200, await service.quote({
        operation: url.searchParams.get("operation") ?? undefined,
        count: url.searchParams.get("count") ?? undefined,
        gasLimit: url.searchParams.get("gasLimit") ?? undefined,
        gasPriceWei: url.searchParams.get("gasPriceWei") ?? undefined,
      }));
      if (request.method === "GET" && path === "/trades") {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "bad request: pagination");
        if (!service.trades) throw new HttpError(503, "trade history is unavailable");
        return json(response, 200, await service.trades(offset, limit));
      }
      if (request.method === "GET" && path === "/trades/stats") {
        const range = url.searchParams.get("range") ?? "1d";
        if (range !== "1d" && range !== "7d" && range !== "30d" && range !== "all") throw new HttpError(400, "bad request: range");
        if (!service.tradeStats) throw new HttpError(503, "trade history is unavailable");
        return json(response, 200, await service.tradeStats(range));
      }
      if (request.method !== "POST" || !POST_PATHS.has(path)) throw new HttpError(404, "not found");
      return json(response, 200, await service.submit(path, await body(request, bodyLimit)));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "error";
      const history = (request.url ?? "").startsWith("/trades");
      json(response, status, { error: status === 500 ? history ? "trade history query failed" : "simulation or relay failed" : message, ...(status >= 400 && status < 500 ? { notBroadcast: true } : {}) });
    }
  });
}
