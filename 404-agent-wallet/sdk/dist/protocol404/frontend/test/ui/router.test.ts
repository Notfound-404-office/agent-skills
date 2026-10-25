import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute } from "../../src/ui/index.ts";

test("parseRoute preserves original routes and doc fallback", () => {
  assert.deepEqual(parseRoute("#/market"), { route: "market", docSlug: "overview" });
  assert.deepEqual(parseRoute("#/docs/keys", ["overview", "keys"]), { route: "docs", docSlug: "keys" });
  assert.deepEqual(parseRoute("#/unknown", ["overview"]), { route: "home", docSlug: "overview" });
});

test("market-only release redirects legacy AMM routes", () => {
  assert.deepEqual(parseRoute("#/trade"), { route: "market", docSlug: "overview" });
  assert.deepEqual(parseRoute("#/swap"), { route: "market", docSlug: "overview" });
  assert.deepEqual(parseRoute("#/docs/swap", ["overview", "market"]), { route: "docs", docSlug: "market" });
});
