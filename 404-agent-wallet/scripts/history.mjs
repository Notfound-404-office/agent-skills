import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSdkRoot } from "./runtime.mjs";

async function corePath(root) {
  const base = root ? resolve(root) : await resolveSdkRoot();
  const candidates = [
    resolve(base, "src/chain/history-core.mjs"),
    resolve(base, "agent-runtime/src/chain/history-core.mjs"),
    resolve(base, "dist/protocol404/agent-runtime/src/chain/history-core.mjs"),
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error("wallet history engine is unavailable in the trusted SDK root");
}

/** Node adapter for the browser-safe shared history engine. */
export async function buildHistory(args, options) {
  const { root, ...context } = args ?? {};
  const module = await import(pathToFileURL(await corePath(root)).href);
  return module.buildHistory(context, options);
}
