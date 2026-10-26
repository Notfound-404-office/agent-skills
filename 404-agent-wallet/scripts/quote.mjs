import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

import { ensurePrivateDir } from "./file-store.mjs";
import { createMarketStore, loadConfig, loadSdk, openPool } from "./sdk.mjs";

const UINT64_LIMIT = 1n << 64n;
const orderFields = ["id", "sellAsset", "open", "releases", "maker", "sellAmount", "buyAmount", "remaining", "proceeds"];

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${label}`);
  return value;
}

function formatAmount(value, symbol) {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ${symbol}`;
}

function sameOrder(left, right) {
  return orderFields.every(field => field === "maker"
    ? String(left?.[field]).toLowerCase() === String(right?.[field]).toLowerCase()
    : left?.[field] === right?.[field]);
}

function validateQuote(quote, orders, dust, feeBps) {
  if (!quote || quote.fills.length < 1 || quote.fills.length > 20) throw new Error("NO_LIQUIDITY: no open listings can fill this request");
  if (new Set(quote.fills.map(fill => fill.orderId.toString())).size !== quote.fills.length) throw new Error("INVALID_QUOTE: duplicate order id");
  if (quote.bought <= 0n || quote.bought >= UINT64_LIMIT || quote.totalPay <= 0n || quote.totalPay >= UINT64_LIMIT) {
    throw new Error("INVALID_QUOTE: batch totals must fit positive uint64 values");
  }
  const byId = new Map(orders.map(order => [order.id, order]));
  let bought = 0n; let pay = 0n; let protocolFee = 0n;
  for (const fill of quote.fills) {
    const order = byId.get(fill.orderId);
    if (!order || !order.open || order.sellAsset !== 0 || order.sellAmount <= 0n || order.buyAmount <= 0n
      || fill.pay <= 0n || fill.pay >= UINT64_LIMIT
      || fill.bought <= 0n || fill.bought > order.remaining) throw new Error("INVALID_QUOTE: selected listing cannot accept its fill");
    if (fill.bought !== fill.pay * order.sellAmount / order.buyAmount
      || fill.protocolFee !== fill.pay * feeBps / 10_000n) throw new Error("INVALID_QUOTE: selected fill math changed");
    const residual = order.remaining - fill.bought;
    if (residual > 0n && residual <= dust) throw new Error("INVALID_QUOTE: selected fill leaves contract dust");
    if (fill.protocolFee < 0n || fill.protocolFee >= fill.pay
      || order.proceeds + fill.pay - fill.protocolFee >= UINT64_LIMIT) {
      throw new Error("INVALID_QUOTE: maker proceeds would exceed uint64");
    }
    bought += fill.bought; pay += fill.pay; protocolFee += fill.protocolFee;
  }
  if (quote.bought !== bought || quote.pay !== pay || quote.protocolFee !== protocolFee || quote.totalPay !== pay + protocolFee) {
    throw new Error("INVALID_QUOTE: batch totals do not match selected fills");
  }
}

export function buildSweepProposal({ orders, requested, budget, dust, feeBps, trading, tokenSymbol = "404", nativeSymbol = "BNB" }) {
  const quote = trading.sweepAmounts(orders, requested, dust, feeBps);
  validateQuote(quote, orders, dust, feeBps);
  if (budget !== undefined && quote.totalPay > budget) {
    throw new Error("BUDGET_EXCEEDED: quote principal plus protocol fee exceeds the reviewed budget");
  }
  return {
    quote,
    result: {
      requested: { raw: requested.toString(), display: formatAmount(requested, tokenSymbol) },
      actual: { raw: quote.bought.toString(), display: formatAmount(quote.bought, tokenSymbol) },
      complete: quote.bought >= requested,
      principal: { raw: quote.pay.toString(), display: formatAmount(quote.pay, nativeSymbol) },
      protocolFee: { raw: quote.protocolFee.toString(), display: formatAmount(quote.protocolFee, nativeSymbol) },
      total: { raw: quote.totalPay.toString(), display: formatAmount(quote.totalPay, nativeSymbol) },
      feeBps: feeBps.toString(),
      orderCount: quote.fills.length,
      reviewRequired: true,
      budgetExcludes: "BAW gas",
    },
  };
}

export async function quoteSweep(opts) {
  const sdk = await loadSdk(opts.root);
  const config = await loadConfig(sdk, required(opts.config, "config"));
  if (config.marketVersion !== 2) throw new Error("MARKET_V2_REQUIRED: sweep quotes require MarketV2");
  const requested = sdk.amount.parseNoteAmount(required(opts.amount, "amount"));
  const budget = opts.budget === undefined ? undefined : sdk.amount.parseNoteAmount(opts.budget);
  const output = isAbsolute(required(opts.out, "out")) ? opts.out : resolve(sdk.root, opts.out);
  const connection = await openPool(sdk, config);
  const marketCacheDir = resolve(homedir(), ".local", "share", "protocol404", "market-cache");
  await ensurePrivateDir(marketCacheDir);
  const marketPath = resolve(marketCacheDir, `market-${config.chain.id}-${config.contracts.market.toLowerCase()}.json`);
  const marketStore = createMarketStore(marketPath);
  const dustAbi = sdk.viem.parseAbi(["function dustSx() view returns (uint64)"]);
  const [orders, feeBps, dustValue] = await Promise.all([
    sdk.trading.readMarketOrders(connection, marketStore),
    sdk.trading.readMarketFeeBps(connection),
    connection.client.readContract({ address: config.contracts.market, abi: dustAbi, functionName: "dustSx" }),
  ]);
  const dust = BigInt(dustValue);
  const proposal = buildSweepProposal({
    orders, requested, budget, dust, feeBps, trading: sdk.trading,
    tokenSymbol: config.brand.tokenSymbol, nativeSymbol: config.chain.nativeCurrency.symbol,
  });
  const selectedIds = proposal.quote.fills.map(fill => fill.orderId);
  const fresh = await sdk.trading.readFreshMarketOrders(connection, selectedIds);
  const original = new Map(orders.map(order => [order.id, order]));
  if (fresh.length !== selectedIds.length || fresh.some(order => !sameOrder(original.get(order.id), order))) {
    throw new Error("QUOTE_STALE: selected market orders changed; request a new quote");
  }
  validateQuote(proposal.quote, fresh, dust, feeBps);

  const fills = proposal.quote.fills.map(fill => ({ orderId: fill.orderId.toString(), pay: fill.pay.toString() }));
  await writePrivate(output, `${JSON.stringify(fills, null, 2)}\n`, { exclusive: true });
  return {
    ...proposal.result,
    fillsFile: output,
    prepare: { fillsFile: output, minBought: proposal.quote.bought.toString(), protocolFee: proposal.quote.protocolFee.toString() },
  };
}
