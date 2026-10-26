import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildSweepProposal } from "./quote.mjs";
import { loadSdk } from "./sdk.mjs";

const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const SCALE = 100_000_000n;
const listing = (id, sellAmount, buyAmount, remaining = sellAmount, proceeds = 0n) => ({
  id, sellAsset: 0, open: true, releases: 0,
  maker: "0x0000000000000000000000000000000000000001",
  sellAmount, buyAmount, remaining, proceeds,
});

test("sweep quote enforces principal plus protocol fee budget", async () => {
  const sdk = await loadSdk(root);
  const input = {
    orders: [listing(1n, 1_000n * SCALE, 100n * SCALE)], requested: 1_000n * SCALE,
    dust: 0n, feeBps: 200n, trading: sdk.trading,
  };
  const accepted = buildSweepProposal({ ...input, budget: 102n * SCALE });
  assert.equal(accepted.quote.pay, 100n * SCALE);
  assert.equal(accepted.quote.protocolFee, 2n * SCALE);
  assert.equal(accepted.result.complete, true);
  assert.throws(() => buildSweepProposal({ ...input, budget: 101n * SCALE }), /BUDGET_EXCEEDED/);
});

test("sweep quote reports actual amount when integer math fills less than requested", async () => {
  const sdk = await loadSdk(root);
  const proposal = buildSweepProposal({
    orders: [listing(1n, 3n, 2n)], requested: 2n, dust: 0n, feeBps: 0n, trading: sdk.trading,
  });
  assert.equal(proposal.result.requested.raw, "2");
  assert.equal(proposal.result.actual.raw, "1");
  assert.equal(proposal.result.complete, false);
});

test("sweep quote avoids a fill that would leave contract dust", async () => {
  const sdk = await loadSdk(root);
  const proposal = buildSweepProposal({
    orders: [listing(1n, 100n, 33n, 99n)], requested: 95n, dust: 10n, feeBps: 0n, trading: sdk.trading,
  });
  assert.equal(proposal.quote.bought, 87n);
  assert.equal(proposal.result.complete, false);
  assert.equal(99n - proposal.quote.bought, 12n);
});
