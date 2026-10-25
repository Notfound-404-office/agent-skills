import type { PoolConnection } from '../chain/client.ts';
import { maxNoteSpend } from '../chain/amount.ts';
import {
  NOTE_SCALE, fillAmounts, isListing, marketFeeOf, maxPayWithMarketFee, oppositeAsset, orderAmounts,
  addSwapLiquidity, orderNativeRemaining, orderPrice, orderSxRemaining, readMarketOrders, readFreshMarketOrders,
  readMarketFeeBps, readMarketStats, readMarketTrades, readSwapState, removeSwapLiquidity, sweepAmounts, swapQuote,
  type Asset, type MarketOrder, type MarketRange, type MarketStats, type MarketTradePage, type SweepQuote, type SwapState,
} from '../chain/trading.ts';
import type { Protocol404Session } from '../flows/session.ts';
import type { ConnectedWallet } from '../wallet/providers.ts';
import { AMM_ENABLED } from '../config/release.ts';

type ConfirmRow = readonly [string, string];
type Disclosure = { public: readonly string[]; hidden?: readonly string[] };
export type TradingUIOptions = {
  getConnection: () => PoolConnection | null;
  getSession: () => Protocol404Session | null;
  getPayer: () => ConnectedWallet | null;
  getRelayerFee?: () => bigint;
  getSpendableValues: (asset: Asset) => readonly bigint[];
  confirm: (title: string, rows: readonly ConfirmRow[], disclosure: Disclosure) => Promise<boolean>;
  progress: (message: string) => void;
  prepareSubmission?: () => void;
  /** Refresh wallet balances and this market once after an action completes. */
  onComplete: () => Promise<void>;
  onSettled?: () => void;
};

const MAX_NOTE_AMOUNT = (1n << 64n) - 1n;

/** Maximum private input; nativeFee remains for legacy callers and is zero in wallet-submit mode. */
export function maxTradingSpend(asset: Asset, values: readonly bigint[], nativeValues: readonly bigint[], nativeFee: bigint): bigint {
  return asset === 1
    ? maxNoteSpend(values, nativeFee)
    : maxNoteSpend(nativeValues) >= nativeFee ? maxNoteSpend(values) : 0n;
}

/** Order amount fields are always token size, including native-funded buy orders. */
export function maxOrderSize(side: 'buy' | 'sell', price: bigint, tokenBudget: bigint, nativeBudget: bigint): bigint {
  if (side === 'sell') return tokenBudget;
  if (price <= 0n) return 0n;
  const size = nativeBudget * 1_000n * NOTE_SCALE / price;
  const maxBuy = (1n << 63n) - 1n;
  return size < maxBuy ? size : maxBuy;
}

export function orderProceedsCoverRelease(buyAmount: bigint, protocolFeeBps: bigint, releaseFee: bigint): boolean {
  return buyAmount - marketFeeOf(buyAmount, protocolFeeBps) > releaseFee;
}

/** A review approves one exact public order state, including its release nonce. */
export function assertReviewedMarketOrders(reviewed: readonly MarketOrder[], current: readonly MarketOrder[]): void {
  const byId = new Map(current.map(order => [order.id, order]));
  if (reviewed.some(order => {
    const latest = byId.get(order.id);
    return !latest || Object.entries(order).some(([key, value]) => latest[key as keyof MarketOrder] !== value);
  })) throw new Error('A selected order changed; review the transaction again');
}

/** Largest valid token request that fits the pay budget without leaving release-fee dust. */
export function maxFillSize(order: MarketOrder, releaseFee: bigint, payBudget: bigint, minimumPay = 0n, protocolFeeBps = 0n): bigint {
  if (payBudget <= 0n || order.remaining <= 0n || order.sellAmount <= 0n || order.buyAmount <= 0n) return 0n;
  const remainingSx = orderSxRemaining(order);
  const affordablePay = maxPayWithMarketFee(payBudget, protocolFeeBps);
  const affordableSx = isListing(order)
    ? affordablePay * order.sellAmount / order.buyAmount
    : affordablePay;
  let requested = [remainingSx, affordableSx, MAX_NOTE_AMOUNT].reduce((minimum, value) => value < minimum ? value : minimum);
  const valid = (amount: bigint): boolean => {
    const result = fillAmounts(order, amount, releaseFee, 0n, undefined, protocolFeeBps);
    return !!result && result.pay > minimumPay && result.totalPay <= payBudget && result.bought <= order.remaining && !result.leavesDust;
  };
  if (valid(requested)) return requested;
  const safeBought = order.remaining > releaseFee + 1n ? order.remaining - releaseFee - 1n : 0n;
  const safePay = ((safeBought + 1n) * order.buyAmount + order.sellAmount - 1n) / order.sellAmount - 1n;
  const cappedPay = safePay < affordablePay ? safePay : affordablePay;
  requested = isListing(order)
    ? ((cappedPay + 1n) * order.sellAmount + order.buyAmount - 1n) / order.buyAmount - 1n
    : cappedPay;
  if (requested > MAX_NOTE_AMOUNT) requested = MAX_NOTE_AMOUNT;
  return requested > 0n && requested <= affordableSx && valid(requested) ? requested : 0n;
}

export function marketChangeBps(stats: Pick<MarketStats, 'last' | 'open24h'>): bigint | null {
  return stats.last === null || stats.open24h === null || stats.open24h === 0n
    ? null
    : (stats.last - stats.open24h) * 10_000n / stats.open24h;
}

export function marketChartGeometry(points: MarketStats['points'], width = 640, height = 220): { line: string; bars: readonly { x: number; y: number; width: number; height: number }[] } {
  const visible = points.map((point, index) => ({ point, index })).filter(value => value.point.close !== null);
  const prices = visible.map(value => value.point.close as bigint);
  const minimum = prices.reduce<bigint | null>((best, value) => best === null || value < best ? value : best, null);
  const maximum = prices.reduce<bigint | null>((best, value) => best === null || value > best ? value : best, null);
  const maxVolume = points.reduce((best, point) => point.native > best ? point.native : best, 0n);
  const chartHeight = Math.round(height * 0.7);
  const x = (index: number): number => points.length <= 1 ? width / 2 : index * width / (points.length - 1);
  const y = (price: bigint): number => minimum === null || maximum === null || minimum === maximum
    ? chartHeight / 2
    : Number((maximum - price) * BigInt(chartHeight) / (maximum - minimum));
  const line = visible.map((value, index) => `${index ? 'L' : 'M'}${x(value.index).toFixed(2)},${y(value.point.close as bigint).toFixed(2)}`).join(' ');
  const barWidth = points.length ? Math.max(1, width / points.length - 2) : 1;
  const bars = points.map((point, index) => {
    const barHeight = maxVolume === 0n ? 0 : Number(point.native * BigInt(height - chartHeight) / maxVolume);
    return { x: x(index) - barWidth / 2, y: height - barHeight, width: barWidth, height: barHeight };
  });
  return { line, bars };
}

export function marketTransactionUrl(chainId: number, tx: string): string {
  const base = chainId === 56 ? 'https://bscscan.com/tx/'
    : chainId === 97 ? 'https://testnet.bscscan.com/tx/'
      : chainId === 11155111 ? 'https://sepolia.etherscan.io/tx/' : '';
  return base ? `${base}${tx}` : '';
}

type View = 'listings' | 'offers' | 'mine';
type Sort = 'price' | 'newest' | 'size';

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing trading UI element #${id}`);
  return node as T;
}

function formField(form: HTMLFormElement, name: string): HTMLInputElement {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) throw new Error(`Missing form field ${name}`);
  return field;
}

function setError(form: HTMLElement, error: unknown): void {
  const node = form.querySelector<HTMLElement>('.error');
  if (node) node.textContent = error instanceof Error ? error.message : String(error);
}

function clearError(form: HTMLElement): void { setError(form, ''); }

export function parseTradingAmount(value: string): bigint {
  const normalized = value.trim().replaceAll(',', '');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(normalized);
  if (!match) throw new Error('Enter a decimal amount with at most 8 decimal places');
  const amount = BigInt(match[1]!) * NOTE_SCALE + BigInt((match[2] ?? '').padEnd(8, '0'));
  if (amount <= 0n || amount >= 1n << 64n) throw new Error('Amount must be positive and fit a 64-bit note');
  return amount;
}

export function formatTradingAmount(amount: bigint, symbol?: string, maximumFractionDigits = 8): string {
  const whole = amount / NOTE_SCALE;
  const fraction = (amount % NOTE_SCALE).toString().padStart(8, '0').replace(/0+$/, '').slice(0, maximumFractionDigits);
  const value = `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
  return symbol ? `${value} ${symbol}` : value;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function receipt(rows: readonly ConfirmRow[]): HTMLDListElement {
  const list = element('dl', 'listing-kv');
  for (const [label, value] of rows) {
    const row = element('div');
    row.append(element('dt', undefined, label), element('dd', undefined, value));
    list.append(row);
  }
  return list;
}

function pendingMakers(session: Protocol404Session): Set<string> {
  const makers = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'maker' && typeof child === 'string' && /^0x[0-9a-f]{40}$/i.test(child)) makers.add(child.toLowerCase());
      else visit(child);
    }
  };
  for (const record of session.pendingTransactions()) {
    if (['prepared', 'unknown', 'submitted'].includes(record.status) && record.intent.kind === 'place') visit(record.body);
  }
  return makers;
}

type MarketExtraElements = {
  sweepOpen: HTMLButtonElement;
  sweepDialog: HTMLDialogElement;
  sweepForm: HTMLFormElement;
  range: HTMLDivElement;
  chart: SVGSVGElement;
  chartEmpty: HTMLParagraphElement;
  last: HTMLElement;
  change: HTMLElement;
  high: HTMLElement;
  low: HTMLElement;
  volume: HTMLElement;
  trades24h: HTMLElement;
  tradesStatus: HTMLParagraphElement;
  tradesBody: HTMLTableSectionElement;
};

function installMarketExtras(): MarketExtraElements {
  const page = byId<HTMLElement>('page-market');
  const headActions = page.querySelector<HTMLElement>('.market-head .row')!;
  const sweepOpen = element('button', undefined, 'Sweep listings');
  sweepOpen.type = 'button'; sweepOpen.id = 'sweep-open'; sweepOpen.hidden = true; headActions.append(sweepOpen);

  const analytics = element('section', 'market-analytics'); analytics.id = 'market-analytics';
  analytics.innerHTML = `<div class="card market-chart-card"><div class="card-head"><h2>Public trades</h2><div class="seg market-ranges" role="group" aria-label="Chart range"><button type="button" data-range="1d" class="active" aria-pressed="true">1D</button><button type="button" data-range="7d" aria-pressed="false">7D</button><button type="button" data-range="30d" aria-pressed="false">30D</button><button type="button" data-range="all" aria-pressed="false">All</button></div></div><svg class="market-chart" viewBox="0 0 640 220" role="img" aria-label="Price and volume history"></svg><p class="muted small market-chart-empty">Market history unavailable</p></div><dl class="card market-day-stats"><div><dt>Last / 1,000</dt><dd data-market-last>—</dd></div><div><dt>24h change</dt><dd data-market-change>—</dd></div><div><dt>24h high</dt><dd data-market-high>—</dd></div><div><dt>24h low</dt><dd data-market-low>—</dd></div><div><dt>24h volume</dt><dd data-market-volume>—</dd></div><div><dt>24h trades</dt><dd data-market-trades>—</dd></div></dl>`;
  page.querySelector('.market-stats')!.after(analytics);

  const history = element('section', 'card trade-history');
  history.setAttribute('data-assets', '');
  history.innerHTML = `<div class="card-head"><h2>Latest trades</h2></div><p class="muted small market-trades-status">Loading public trades…</p><div class="trade-table-wrap"><table class="trade-table"><thead><tr><th>Time</th><th>Side</th><th>Price / 1,000</th><th>{token}</th><th>BNB</th><th>Tx</th></tr></thead><tbody></tbody></table></div>`;
  byId('listings').after(history);

  const sweepDialog = element('dialog', 'sheet-dialog market-dialog') as HTMLDialogElement;
  sweepDialog.setAttribute('data-assets', '');
  sweepDialog.id = 'sweep-dialog'; sweepDialog.setAttribute('aria-labelledby', 'sweep-title');
  sweepDialog.innerHTML = `<div class="dialog-head"><h2 class="title" id="sweep-title">Sweep listings</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></div><form class="action" id="sweep-form" autocomplete="off"><p class="lead-note">Buy across up to 20 listings, cheapest first.</p><label>{token} to buy<input name="amount" inputmode="decimal" placeholder="0" /></label><dl class="receipt" id="sweep-total"></dl><p class="needs-wallet" id="sweep-needs-wallet">Wallet locked<a class="text-btn" href="#/profile">Open wallet</a></p><button class="primary wide" id="sweep-submit">Review sweep</button><p class="error maskable" role="alert"></p></form>`;
  document.body.append(sweepDialog);
  const sweepForm = sweepDialog.querySelector<HTMLFormElement>('form')!;
  return {
    sweepOpen, sweepDialog, sweepForm,
    range: analytics.querySelector<HTMLDivElement>('.market-ranges')!, chart: analytics.querySelector<SVGSVGElement>('svg')!,
    chartEmpty: analytics.querySelector<HTMLParagraphElement>('.market-chart-empty')!,
    last: analytics.querySelector('[data-market-last]')!, change: analytics.querySelector('[data-market-change]')!,
    high: analytics.querySelector('[data-market-high]')!, low: analytics.querySelector('[data-market-low]')!,
    volume: analytics.querySelector('[data-market-volume]')!, trades24h: analytics.querySelector('[data-market-trades]')!,
    tradesStatus: history.querySelector<HTMLParagraphElement>('.market-trades-status')!, tradesBody: history.querySelector<HTMLTableSectionElement>('tbody')!,
  };
}

export const ORDER_KEY_RECOVERY_LIMIT = 10_000;

type DerivedOrderMakers = {
  makers: readonly string[];
  byMaker: ReadonlyMap<string, number>;
};

const derivedOrderMakers = new WeakMap<Protocol404Session, Promise<DerivedOrderMakers>>();

async function orderMakers(session: Protocol404Session): Promise<DerivedOrderMakers> {
  const cached = derivedOrderMakers.get(session);
  if (cached) return cached;
  const pending = (async () => {
    const makers: string[] = [];
    const byMaker = new Map<string, number>();
    for (let index = 0; index < ORDER_KEY_RECOVERY_LIMIT; index++) {
      const maker = session.orderMaker(index).toLowerCase();
      makers.push(maker);
      byMaker.set(maker, index);
      if ((index + 1) % 64 === 0 && index + 1 < ORDER_KEY_RECOVERY_LIMIT) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    return { makers, byMaker };
  })();
  derivedOrderMakers.set(session, pending);
  try {
    return await pending;
  } catch (error) {
    derivedOrderMakers.delete(session);
    throw error;
  }
}

/** Scan the deterministic-key space and reserve keys seen on chain or in unresolved journals. */
export async function recoverOrderKeys(session: Protocol404Session, orders: readonly MarketOrder[]): Promise<{ byOrder: Map<bigint, number>; next: number | null }> {
  const { makers, byMaker } = await orderMakers(session);
  const used = new Set(orders.map(order => order.maker.toLowerCase()));
  for (const maker of pendingMakers(session)) used.add(maker);
  const nextIndex = makers.findIndex(maker => !used.has(maker));
  const next = nextIndex < 0 ? null : nextIndex;
  const byOrder = new Map<bigint, number>();
  for (const order of orders) {
    const index = byMaker.get(order.maker.toLowerCase());
    if (index !== undefined) byOrder.set(order.id, index);
  }
  return { byOrder, next };
}

export function initTradingUI(options: TradingUIOptions): { refresh(): Promise<void>; renderBalances(): void } {
  const marketExtras = installMarketExtras();
  const swapForm = byId<HTMLFormElement>('swap-form');
  const orderForm = byId<HTMLFormElement>('order-form');
  const fillForm = byId<HTMLFormElement>('fill-form');
  const liquidityForm = byId<HTMLFormElement>('liquidity-form');
  const orderDialog = byId<HTMLDialogElement>('order-dialog');
  const fillDialog = byId<HTMLDialogElement>('fill-dialog');
  let swapIn: Asset = 0;
  let slippageBps = 50n;
  let swapState: SwapState | null = null;
  let orders: MarketOrder[] = [];
  let keys = new Map<bigint, number>();
  let orderSide: 'buy' | 'sell' = 'sell';
  let marketView: View = 'listings';
  let marketSort: Sort = 'price';
  let fillId: bigint | null = null;
  let marketFeeBps: bigint | null = 0n;
  let marketRange: MarketRange = '1d';
  let marketStats: MarketStats | null = null;
  let marketTrades: MarketTradePage | null = null;
  let marketDataError = '';
  let sweepQuote: SweepQuote | null = null;
  let busy = false;
  const maximums: Record<'swap' | 'order' | 'fill', bigint> = { swap: 0n, order: 0n, fill: 0n };

  for (const form of [swapForm, liquidityForm]) {
    form.setAttribute('aria-disabled', String(!AMM_ENABLED));
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea')) {
      control.disabled = !AMM_ENABLED;
    }
  }

  const connection = (): PoolConnection => {
    const value = options.getConnection();
    if (!value) throw new Error('This network is not configured');
    return value;
  };
  const session = (): Protocol404Session => {
    const value = options.getSession();
    if (!value) throw new Error('Open your private wallet first');
    return value;
  };
  const symbols = (): readonly [string, string] => {
    const config = options.getConnection()?.config;
    return [config?.brand.tokenSymbol ?? '404', config?.chain.nativeCurrency.symbol ?? 'BNB'];
  };
  const feeFor = (asset: Asset): bigint => asset === 0 ? 0n : options.getRelayerFee?.() ?? 0n;
  const marketVersion = (): 1 | 2 => options.getConnection()?.config.marketVersion ?? 1;
  const protocolBps = (): bigint => marketVersion() === 2 ? marketFeeBps ?? 0n : 0n;
  const actionFeeAsset = (asset: Asset): Asset => asset === 0 ? 1 : asset;
  const values = (asset: Asset): readonly bigint[] => options.getSpendableValues(asset);
  const totalAvailable = (asset: Asset): bigint => values(asset).reduce((sum, value) => sum + value, 0n);
  const budget = (asset: Asset): bigint => maxTradingSpend(asset, values(asset), values(1), feeFor(1));
  const setHint = (name: 'swap' | 'order' | 'fill', text: string, maximum: bigint): void => {
    maximums[name] = maximum;
    const hint = document.querySelector<HTMLElement>(`[data-hint="${name}"]`)!;
    hint.querySelector('span')!.textContent = text;
    hint.querySelector<HTMLButtonElement>('[data-max]')!.hidden = maximum <= 0n;
  };
  const optionalAmount = (form: HTMLFormElement, name: string): bigint => {
    const value = formField(form, name).value.trim();
    return value ? parseTradingAmount(value) : 0n;
  };

  const renderMarketData = (): void => {
    const [token, native] = symbols();
    const stats = marketStats;
    marketExtras.last.textContent = stats?.last === null || !stats ? 'Unavailable' : formatTradingAmount(stats.last, native);
    const change = stats ? marketChangeBps(stats) : null;
    marketExtras.change.textContent = change === null ? 'Unavailable' : `${change > 0n ? '+' : ''}${(Number(change) / 100).toFixed(2)}%`;
    marketExtras.change.classList.toggle('positive', change !== null && change > 0n);
    marketExtras.change.classList.toggle('negative', change !== null && change < 0n);
    marketExtras.high.textContent = stats?.high24h === null || !stats ? 'Unavailable' : formatTradingAmount(stats.high24h, native);
    marketExtras.low.textContent = stats?.low24h === null || !stats ? 'Unavailable' : formatTradingAmount(stats.low24h, native);
    marketExtras.volume.textContent = stats ? `${formatTradingAmount(stats.volume24h.token, token)} · ${formatTradingAmount(stats.volume24h.native, native)}` : 'Unavailable';
    marketExtras.trades24h.textContent = stats ? stats.trades24h.toLocaleString('en-US') : 'Unavailable';
    const geometry = stats ? marketChartGeometry(stats.points) : { line: '', bars: [] };
    marketExtras.chart.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg';
    for (const bar of geometry.bars) {
      const rect = document.createElementNS(ns, 'rect'); rect.setAttribute('class', 'market-volume-bar');
      for (const [name, value] of Object.entries(bar)) rect.setAttribute(name, String(value));
      marketExtras.chart.append(rect);
    }
    if (geometry.line) {
      const path = document.createElementNS(ns, 'path'); path.setAttribute('class', 'market-price-line'); path.setAttribute('d', geometry.line); marketExtras.chart.append(path);
    }
    marketExtras.chartEmpty.hidden = !!geometry.line;
    marketExtras.chartEmpty.textContent = stats ? 'No trades in this range' : 'Market history unavailable';
    const headings = marketExtras.tradesBody.closest('table')!.querySelectorAll('th');
    headings[2]!.textContent = `Price / 1,000 ${token}`; headings[3]!.textContent = token; headings[4]!.textContent = native;

    marketExtras.tradesBody.replaceChildren();
    if (!marketTrades) {
      marketExtras.tradesStatus.hidden = false;
      marketExtras.tradesStatus.textContent = marketDataError || 'Public trade history unavailable';
      return;
    }
    marketExtras.tradesStatus.hidden = marketTrades.trades.length > 0;
    marketExtras.tradesStatus.textContent = marketTrades.trades.length ? '' : 'No public trades have been indexed yet';
    for (const trade of marketTrades.trades) {
      const tokenAmount = trade.sellAsset === 0 ? trade.bought : trade.paid;
      const nativeAmount = trade.sellAsset === 0 ? trade.paid : trade.bought;
      const row = element('tr');
      for (const value of [
        new Date(trade.time * 1_000).toLocaleString(), trade.sellAsset === 0 ? 'Buy' : 'Sell',
        formatTradingAmount(trade.price, native), formatTradingAmount(tokenAmount, token), formatTradingAmount(nativeAmount, native),
      ]) row.append(element('td', undefined, value));
      const txCell = element('td');
      const txUrl = marketTransactionUrl(options.getConnection()?.config.chain.id ?? 0, trade.tx);
      if (txUrl) {
        const link = element('a', 'trade-tx', `${trade.tx.slice(0, 8)}…${trade.tx.slice(-6)}`);
        link.href = txUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = trade.tx;
        txCell.append(link);
      } else txCell.textContent = `${trade.tx.slice(0, 8)}…${trade.tx.slice(-6)}`;
      row.append(txCell);
      marketExtras.tradesBody.append(row);
    }
  };

  const updateSweepDialog = (): void => {
    const [token, native] = symbols();
    marketExtras.sweepForm.querySelector<HTMLElement>('.lead-note')!.textContent = `Buy ${token} across up to 20 listings, cheapest first.`;
    byId('sweep-needs-wallet').hidden = !!options.getSession();
    sweepQuote = null;
    try {
      sweepQuote = sweepAmounts(orders, parseTradingAmount(formField(marketExtras.sweepForm, 'amount').value), feeFor(0), protocolBps());
    } catch { /* incomplete input */ }
    const total = byId<HTMLDListElement>('sweep-total'); total.replaceChildren();
    if (sweepQuote) {
      for (const [label, value] of [
        ['Listings', String(sweepQuote.fills.length)],
        ['Actual received', formatTradingAmount(sweepQuote.bought, token)],
        ['Trade principal', formatTradingAmount(sweepQuote.pay, native)],
        ['Protocol fee', formatTradingAmount(sweepQuote.protocolFee, native)],
      ] as const) total.append(element('dt', undefined, label), element('dd', undefined, value));
    }
    byId<HTMLButtonElement>('sweep-submit').disabled = busy || !options.getSession() || !sweepQuote
      || sweepQuote.totalPay > budget(1) || marketFeeBps === null;
  };

  const updateSwap = (): void => {
    const [token, native] = symbols();
    for (const node of document.querySelectorAll<HTMLElement>('[data-native]')) node.textContent = native;
    const outAsset = oppositeAsset(swapIn);
    byId('swap-in-token').textContent = swapIn === 0 ? token : native;
    byId('swap-out-token').textContent = outAsset === 0 ? token : native;
    byId('swap-needs-wallet').hidden = !!options.getSession();
    const ready = !!swapState && swapState.reserveToken > 0n && swapState.reserveNative > 0n;
    byId('pool-token').textContent = swapState ? formatTradingAmount(swapState.reserveToken) : '—';
    byId('pool-native').textContent = swapState ? formatTradingAmount(swapState.reserveNative) : '—';
    byId('pool-price').textContent = ready && swapState
      ? `1 ${native} = ${(Number(swapState.reserveToken * 100n / swapState.reserveNative) / 100).toLocaleString('en-US')} ${token}`
      : swapState ? 'No liquidity yet' : 'No swap pool on this network';
    let amount = 0n;
    try { amount = parseTradingAmount(formField(swapForm, 'amount').value); } catch { /* incomplete input */ }
    const output = ready && swapState ? swapQuote(swapState, swapIn, amount) : 0n;
    byId('swap-out').textContent = output > 0n ? formatTradingAmount(output) : '0';
    if (ready && swapState && amount > 0n && output > 0n) {
      const [reserveIn, reserveOut] = swapIn === 0
        ? [swapState.reserveToken, swapState.reserveNative]
        : [swapState.reserveNative, swapState.reserveToken];
      const ideal = amount * reserveOut / reserveIn;
      const impact = ideal === 0n ? '—' : `${(Number((ideal - output) * 1_000_000n / ideal) / 10_000).toFixed(2)}%`;
      byId('swap-price').textContent = swapIn === 0
        ? `1 ${native} = ${(Number(amount * 100n / output) / 100).toLocaleString('en-US')} ${token}`
        : `1 ${native} = ${(Number(output * 100n / amount) / 100).toLocaleString('en-US')} ${token}`;
      byId('swap-impact').textContent = impact;
      byId('swap-min').textContent = formatTradingAmount(output * (10_000n - slippageBps) / 10_000n, outAsset === 0 ? token : native);
    } else {
      for (const id of ['swap-price', 'swap-impact', 'swap-min']) byId(id).textContent = '—';
    }
    const available = totalAvailable(swapIn);
    const maximum = budget(swapIn);
    const symbol = swapIn === 0 ? token : native;
    setHint('swap', `${formatTradingAmount(available, symbol)} total · up to ${formatTradingAmount(maximum, symbol)} per transaction`, maximum);
    byId<HTMLButtonElement>('swap-submit').disabled = !AMM_ENABLED || busy || !ready || !options.getSession();
    const payer = options.getPayer();
    byId('liquidity-card').hidden = !AMM_ENABLED || !(payer && swapState && payer.address.toLowerCase() === swapState.owner.toLowerCase());
    for (const button of liquidityForm.querySelectorAll<HTMLButtonElement>('button[data-liquidity]')) button.disabled = !AMM_ENABLED || busy;
  };

  const currentOrderAmounts = () => {
    try {
      return orderAmounts(orderSide, parseTradingAmount(formField(orderForm, 'price').value), parseTradingAmount(formField(orderForm, 'amount').value));
    } catch { return null; }
  };

  const updateOrderDialog = (): void => {
    const [token, native] = symbols();
    byId('order-title').textContent = orderSide === 'buy' ? 'Make an offer' : `List ${token}`;
    byId<HTMLButtonElement>('order-submit').textContent = orderSide === 'buy' ? 'Offer privately' : 'List privately';
    byId('order-needs-wallet').hidden = !!options.getSession();
    byId<HTMLButtonElement>('order-submit').disabled = busy || !options.getSession() || !options.getConnection()
      || (marketVersion() === 2 && marketFeeBps === null);
    const sellAsset: Asset = orderSide === 'buy' ? 1 : 0;
    const available = totalAvailable(sellAsset);
    const payBudget = budget(sellAsset);
    let price = 0n;
    try { price = parseTradingAmount(formField(orderForm, 'price').value); } catch { /* incomplete price */ }
    let maximum = maxOrderSize(orderSide, price, budget(0), payBudget);
    const maximumAmounts = price > 0n && maximum > 0n ? orderAmounts(orderSide, price, maximum) : null;
    if (!maximumAmounts || maximumAmounts.sellAmount <= feeFor(maximumAmounts.sellAsset)
      || !orderProceedsCoverRelease(maximumAmounts.buyAmount, protocolBps(), feeFor(oppositeAsset(maximumAmounts.sellAsset)))) maximum = 0n;
    const symbol = sellAsset === 0 ? token : native;
    setHint('order', orderSide === 'buy' && price === 0n
        ? `${formatTradingAmount(available, native)} total · enter a price to calculate Max ${token}`
        : `${formatTradingAmount(available, symbol)} total · up to ${formatTradingAmount(maximum, token)} per transaction`, maximum);
    const amounts = currentOrderAmounts();
    const total = byId<HTMLDListElement>('order-total');
    total.replaceChildren();
    if (!amounts) return;
    const rows: ConfirmRow[] = [
      [amounts.sellAsset === 0 ? 'Listed' : 'Offered', formatTradingAmount(amounts.sellAmount, amounts.sellAsset === 0 ? token : native)],
      ['Protocol fee when filled', marketVersion() === 2 ? formatTradingAmount(marketFeeOf(amounts.buyAmount, protocolBps()), amounts.sellAsset === 0 ? native : token) : 'Not charged on Market V1'],
      ['You receive after protocol fee', formatTradingAmount(amounts.buyAmount - marketFeeOf(amounts.buyAmount, protocolBps()), amounts.sellAsset === 0 ? native : token)],
    ];
    for (const [label, value] of rows) total.append(element('dt', undefined, label), element('dd', undefined, value));
  };

  const activeFill = (): MarketOrder | null => orders.find(order => order.id === fillId) ?? null;
  const currentFillAmounts = () => {
    const order = activeFill();
    if (!order) return null;
    try { return fillAmounts(order, parseTradingAmount(formField(fillForm, 'amount').value), feeFor(order.sellAsset), 0n, undefined, protocolBps()); }
    catch { return null; }
  };

  const updateFillDialog = (): void => {
    const order = activeFill();
    if (!order) { if (fillDialog.open) fillDialog.close(); return; }
    const [token, native] = symbols();
    const listing = isListing(order);
    const payAsset = listing ? 1 : 0;
    byId('fill-title').textContent = `${listing ? 'Buy from listing' : 'Sell to offer'} #${order.id}`;
    byId('fill-submit').textContent = listing ? 'Buy privately' : 'Sell privately';
    byId('fill-terms').textContent = `${listing ? 'Sells' : 'Buys'} up to ${formatTradingAmount(orderSxRemaining(order), token)} at ${formatTradingAmount(orderPrice(order), native)} per 1,000 ${token}.`;
    byId('fill-label').textContent = listing ? `${token} to buy` : `${token} to sell`;
    byId('fill-needs-wallet').hidden = !!options.getSession();
    byId<HTMLButtonElement>('fill-submit').disabled = busy || !options.getSession() || !order.open || (marketVersion() === 2 && marketFeeBps === null);
    const available = totalAvailable(payAsset);
    const payBudget = budget(payAsset);
    const maximum = maxFillSize(order, feeFor(order.sellAsset), payBudget, feeFor(payAsset), protocolBps());
    const paySymbol = payAsset === 0 ? token : native;
    setHint('fill', `${formatTradingAmount(available, paySymbol)} total · up to ${formatTradingAmount(maximum, token)} ${token} this transaction`, maximum);
    const result = currentFillAmounts();
    const total = byId<HTMLDListElement>('fill-total');
    total.replaceChildren();
    if (!result) return;
    const rows: ConfirmRow[] = [
      ['You pay', formatTradingAmount(result.pay, payAsset === 0 ? token : native)],
      ['Protocol fee', marketVersion() === 2 ? formatTradingAmount(result.protocolFee, payAsset === 0 ? token : native) : 'Not charged on Market V1'],
      ['You receive', formatTradingAmount(result.bought, order.sellAsset === 0 ? token : native)],
    ];
    for (const [label, value] of rows) total.append(element('dt', undefined, label), element('dd', undefined, value));
  };

  const media = (order: MarketOrder, amount: bigint, tag = ''): HTMLDivElement => {
    const node = element('div', 'listing-media');
    node.append(element('span', 'listing-id', `#${order.id}`));
    const quantity = element('p', 'listing-amount maskable', formatTradingAmount(amount));
    quantity.append(element('span', 'unit', ` ${symbols()[0]}`));
    node.append(quantity);
    if (tag) node.append(element('span', 'listing-tag', tag));
    const percent = order.sellAmount === 0n ? 0n : (order.sellAmount - order.remaining) * 100n / order.sellAmount;
    if (percent > 0n) {
      const fill = element('div', 'listing-fill');
      const progress = element('progress'); progress.max = 100; progress.value = Number(percent);
      fill.append(progress, element('span', undefined, `${percent}% filled`)); node.append(fill);
    }
    return node;
  };

  const refreshOrdersForAction = async (ids: readonly bigint[]): Promise<MarketOrder[]> => {
    const activeConnection = connection(), activeSession = options.getSession();
    const fresh = await readFreshMarketOrders(activeConnection, ids);
    if (options.getConnection() !== activeConnection || options.getSession() !== activeSession) {
      throw new Error('Wallet changed; review the order again');
    }
    const byOrder = new Map(fresh.map(order => [order.id, order]));
    orders = orders.map(order => byOrder.get(order.id) ?? order);
    return fresh;
  };

  const performRelease = async (order: MarketOrder, action: 0 | 1): Promise<void> => {
    if (busy) return;
    options.prepareSubmission?.();
    const activeSession = session();
    [order] = await refreshOrdersForAction([order.id]);
    if (!order || (action === 1 && !order.open)) throw new Error('This order is no longer open');
    const keyIndex = keys.get(order.id);
    if (keyIndex === undefined) throw new Error('The deterministic key for this order was not recovered');
    const asset = action === 0 ? oppositeAsset(order.sellAsset) : order.sellAsset;
    const amount = action === 0 ? order.proceeds : order.remaining;
    const [token, native] = symbols();
    if (amount <= feeFor(asset)) throw new Error('The amount is not larger than its release fee');
    const title = `${action === 0 ? 'Claim' : 'Cancel'} order #${order.id}`;
    if (!await options.confirm(title, [
      [action === 0 ? 'Proceeds' : 'Left in the order', formatTradingAmount(amount, asset === 0 ? token : native)],
    ], { public: ['Order', 'Action', 'Fee'], hidden: ['Private recipient'] })) return;
    busy = true; renderMarket();
    try {
      assertReviewedMarketOrders([order], await refreshOrdersForAction([order.id]));
      await activeSession.releaseOrder({ orderId: order.id, action, asset, keyIndex, nonce: order.releases }, options.progress);
      await options.onComplete();
    } finally {
      options.onSettled?.();
      busy = false; renderMarket();
    }
  };

  const renderMarket = (): void => {
    const [token, native] = symbols();
    const marketStatLabels = byId('page-market').querySelectorAll<HTMLElement>('.market-stats dt');
    marketStatLabels[0]!.textContent = `Floor / 1,000 ${token}`;
    marketStatLabels[1]!.textContent = `Best offer / 1,000 ${token}`;
    const active = orders.filter(order => order.open && order.remaining > 0n);
    const listings = active.filter(isListing);
    const offers = active.filter(order => !isListing(order));
    const mine = orders.filter(order => keys.has(order.id));
    const minPrice = listings.reduce<bigint | null>((best, order) => best === null || orderPrice(order) < best ? orderPrice(order) : best, null);
    const maxPrice = offers.reduce<bigint | null>((best, order) => best === null || orderPrice(order) > best ? orderPrice(order) : best, null);
    byId('mk-floor').textContent = minPrice === null ? '—' : formatTradingAmount(minPrice, native);
    byId('mk-offer').textContent = maxPrice === null ? '—' : formatTradingAmount(maxPrice, native);
    byId('mk-listed').textContent = listings.length ? formatTradingAmount(listings.reduce((sum, order) => sum + orderSxRemaining(order), 0n), token) : '—';
    byId('mk-offered').textContent = offers.length ? formatTradingAmount(offers.reduce((sum, order) => sum + order.remaining, 0n), native) : '—';
    byId('mk-listings-count').textContent = listings.length ? String(listings.length) : '';
    byId('mk-offers-count').textContent = offers.length ? String(offers.length) : '';
    byId('my-orders-count').textContent = mine.length ? String(mine.length) : '';
    byId('mk-mine-tab').hidden = !options.getSession();
    if (!options.getSession() && marketView === 'mine') marketView = 'listings';
    for (const button of byId('market-tabs').querySelectorAll<HTMLButtonElement>('button[data-view]')) {
      const selected = button.dataset.view === marketView;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
    }
    byId<HTMLSelectElement>('market-sort').hidden = marketView === 'mine';
    const visible = marketView === 'listings' ? listings : marketView === 'offers' ? offers : mine;
    visible.sort((left, right) => {
      const compare = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;
      if (marketView === 'mine' || marketSort === 'newest') return compare(right.id, left.id);
      if (marketSort === 'size') return compare(orderSxRemaining(right), orderSxRemaining(left));
      return marketView === 'listings' ? compare(orderPrice(left), orderPrice(right)) : compare(orderPrice(right), orderPrice(left));
    });
    const list = byId<HTMLUListElement>('listings'); list.replaceChildren();
    if (!visible.length) {
      list.append(element('li', 'listing-empty', marketView === 'listings' ? `No ${token} listed yet` : marketView === 'offers' ? 'No offers yet' : 'No orders yet'));
      return;
    }
    for (const order of visible) {
      const own = keys.has(order.id);
      const item = element('li', `listing${order.open ? '' : ' closed'}`);
      if (marketView === 'mine') {
        item.append(media(order, isListing(order) ? order.sellAmount : order.buyAmount, isListing(order) ? 'Selling' : 'Buying'));
        const body = element('div', 'listing-body');
        body.append(receipt([
          [`Per 1,000 ${token}`, formatTradingAmount(orderPrice(order), native)],
          ['To claim', formatTradingAmount(order.proceeds, oppositeAsset(order.sellAsset) === 0 ? token : native)],
        ]));
        const actions = element('div', 'listing-actions');
        if (order.proceeds > feeFor(oppositeAsset(order.sellAsset))) {
          const claim = element('button', 'small primary', 'Claim'); claim.type = 'button';
          claim.addEventListener('click', () => { void performRelease(order, 0).catch(error => { byId('my-orders-error').textContent = error instanceof Error ? error.message : String(error); }); });
          actions.append(claim);
        }
        if (order.open && order.remaining > feeFor(order.sellAsset)) {
          const cancel = element('button', 'small', 'Cancel'); cancel.type = 'button';
          cancel.addEventListener('click', () => { void performRelease(order, 1).catch(error => { byId('my-orders-error').textContent = error instanceof Error ? error.message : String(error); }); });
          actions.append(cancel);
        }
        if (!actions.childElementCount) actions.append(element('span', 'muted small', order.open ? 'Open' : 'Closed'));
        body.append(actions); item.append(body);
      } else {
        item.append(media(order, orderSxRemaining(order), own ? 'Yours' : ''));
        const body = element('div', 'listing-body');
        const payAsset: Asset = isListing(order) ? 1 : 0;
        const principal = isListing(order) ? orderNativeRemaining(order) : orderSxRemaining(order);
        const paySymbol = payAsset === 0 ? token : native;
        const feeKnown = marketVersion() === 1 || marketFeeBps !== null;
        body.append(receipt([
          [`Per 1,000 ${token}`, formatTradingAmount(orderPrice(order), native)],
          ['Taker pays', feeKnown ? formatTradingAmount(principal + marketFeeOf(principal, protocolBps()), paySymbol) : 'Protocol fee unavailable'],
          ['Maker receives', feeKnown ? formatTradingAmount(principal - marketFeeOf(principal, protocolBps()), paySymbol) : 'Protocol fee unavailable'],
        ]));
        const actions = element('div', 'listing-actions');
        const button = element('button', own ? 'small' : 'small primary', own ? 'Your order' : isListing(order) ? 'Buy' : 'Sell');
        button.type = 'button'; button.disabled = busy;
        button.addEventListener('click', () => {
          if (own) { marketView = 'mine'; renderMarket(); return; }
          fillId = order.id; fillForm.reset(); clearError(fillForm); updateFillDialog(); fillDialog.showModal(); formField(fillForm, 'amount').focus();
        });
        actions.append(button); body.append(actions); item.append(body);
      }
      list.append(item);
    }
  };

  const refreshMarketData = async (activeConnection: PoolConnection): Promise<void> => {
    const range = marketRange;
    const [statsResult, tradesResult] = await Promise.allSettled([
      readMarketStats(activeConnection, range), readMarketTrades(activeConnection),
    ]);
    if (options.getConnection() !== activeConnection || marketRange !== range) return;
    marketStats = statsResult.status === 'fulfilled' ? statsResult.value : null;
    marketTrades = tradesResult.status === 'fulfilled' ? tradesResult.value : null;
    const failures = [statsResult, tradesResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
    marketDataError = failures.length ? 'Public market data unavailable' : '';
    renderMarketData();
  };

  const refresh = async (): Promise<void> => {
    const activeConnection = options.getConnection();
    const activeSession = options.getSession();
    if (!activeConnection) {
      swapState = null; orders = []; keys = new Map();
      marketStats = null; marketTrades = null; marketDataError = 'Public market data unavailable'; marketFeeBps = 0n;
      updateSwap(); renderMarket(); renderMarketData(); return;
    }
    const [newOrders, feeResult] = await Promise.all([
      readMarketOrders(activeConnection),
      activeConnection.config.marketVersion === 2 ? readMarketFeeBps(activeConnection).then(value => ({ value })).catch(() => ({ value: null })) : Promise.resolve({ value: 0n }),
    ]);
    const reservation = activeSession ? await recoverOrderKeys(activeSession, newOrders) : null;
    if (options.getConnection() !== activeConnection || options.getSession() !== activeSession) return;
    swapState = null; orders = newOrders;
    marketFeeBps = feeResult.value;
    keys = reservation?.byOrder ?? new Map();
    marketExtras.sweepOpen.hidden = activeConnection.config.marketVersion !== 2;
    updateSwap(); updateOrderDialog(); updateFillDialog(); renderMarket(); renderMarketData();
    void refreshMarketData(activeConnection);
  };

  byId('swap-flip').addEventListener('click', () => { swapIn = oppositeAsset(swapIn); formField(swapForm, 'amount').value = ''; clearError(swapForm); updateSwap(); });
  for (const [name, form] of [['swap', swapForm], ['order', orderForm], ['fill', fillForm]] as const) {
    document.querySelector<HTMLButtonElement>(`[data-hint="${name}"] [data-max]`)!.addEventListener('click', () => {
      const maximum = maximums[name];
      if (maximum <= 0n) return;
      formField(form, 'amount').value = formatTradingAmount(maximum);
      formField(form, 'amount').dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  formField(swapForm, 'amount').addEventListener('input', updateSwap);
  byId('slippage').addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-bps]');
    if (!button) return;
    slippageBps = BigInt(button.dataset.bps!);
    for (const choice of byId('slippage').querySelectorAll<HTMLButtonElement>('button[data-bps]')) {
      const selected = choice === button; choice.classList.toggle('active', selected); choice.setAttribute('aria-pressed', String(selected));
    }
    updateSwap();
  });
  swapForm.addEventListener('submit', event => {
    event.preventDefault();
    setError(swapForm, new Error('Swap is not available in this release'));
  });

  const changeLiquidity = async (kind: 'add' | 'remove'): Promise<void> => {
    clearError(liquidityForm);
    if (!AMM_ENABLED) { setError(liquidityForm, new Error('Liquidity management is not available in this release')); return; }
    try {
      const activeConnection = connection();
      const payer = options.getPayer();
      const activeSession = options.getSession();
      if (!payer) throw new Error('Connect a public wallet first');
      const live = await readSwapState(activeConnection);
      swapState = live;
      if (payer.address.toLowerCase() !== live.owner.toLowerCase()) throw new Error('Only the swap treasury owner can change liquidity');
      const amounts = { token: optionalAmount(liquidityForm, 'token'), native: optionalAmount(liquidityForm, 'native') };
      if (amounts.token === 0n && amounts.native === 0n) throw new Error('Enter an amount');
      const [token, native] = symbols();
      if (!await options.confirm(`${kind === 'add' ? 'Add' : 'Remove'} liquidity`, [
        [token, formatTradingAmount(amounts.token, token)],
        [native, formatTradingAmount(amounts.native, native)],
        ['Account', payer.address],
      ], { public: ['This account', 'Amounts', 'Reserves'] })) return;
      busy = true; updateSwap();
      const assertCurrent = () => {
        if (options.getConnection() !== activeConnection || options.getPayer() !== payer || options.getSession() !== activeSession) {
          throw new Error('Wallet changed; review the liquidity transaction again');
        }
      };
      if (kind === 'add') await addSwapLiquidity(activeConnection, payer, amounts, options.progress, assertCurrent);
      else await removeSwapLiquidity(activeConnection, payer, amounts, options.progress, assertCurrent);
      liquidityForm.reset();
      await options.onComplete();
      await refresh();
    } catch (error) { setError(liquidityForm, error); }
    finally { options.onSettled?.(); busy = false; updateSwap(); }
  };
  liquidityForm.addEventListener('submit', event => { event.preventDefault(); void changeLiquidity('add'); });
  liquidityForm.querySelector<HTMLButtonElement>('button[data-liquidity="remove"]')?.addEventListener('click', () => { void changeLiquidity('remove'); });

  const openOrder = (side: 'buy' | 'sell'): void => {
    orderSide = side; orderForm.reset(); clearError(orderForm); updateOrderDialog();
    if (!orderDialog.open) orderDialog.showModal(); formField(orderForm, 'price').focus();
  };
  byId('list-open').addEventListener('click', () => openOrder('sell'));
  byId('offer-open').addEventListener('click', () => openOrder('buy'));
  orderForm.addEventListener('input', updateOrderDialog);
  orderForm.addEventListener('submit', event => { event.preventDefault(); void (async () => {
    clearError(orderForm);
    try {
      options.prepareSubmission?.();
      const activeSession = session(); const amounts = currentOrderAmounts();
      if (!amounts) throw new Error('Enter a price and a size; the total must be more than zero');
      const makerProtocolFee = marketFeeOf(amounts.buyAmount, protocolBps());
      if (amounts.sellAmount <= feeFor(amounts.sellAsset)
        || !orderProceedsCoverRelease(amounts.buyAmount, protocolBps(), feeFor(oppositeAsset(amounts.sellAsset)))) {
        throw new Error('An order must pay in enough that its proceeds after protocol fee still exceed the release fee');
      }
      const [token, native] = symbols(); const verb = orderSide === 'buy' ? 'Buy' : 'Sell';
      const receiveSymbol = amounts.sellAsset === 0 ? native : token;
      if (!await options.confirm(`${verb} ${formatTradingAmount(amounts.token, token)}`, [
        ['You pay now', formatTradingAmount(amounts.sellAmount, amounts.sellAsset === 0 ? token : native)],
        ['Protocol fee when filled', marketVersion() === 2 ? formatTradingAmount(makerProtocolFee, receiveSymbol) : 'Not charged on Market V1'],
        ['You receive after protocol fee', formatTradingAmount(amounts.buyAmount - makerProtocolFee, receiveSymbol)],
      ], { public: ['Price', 'Size', 'Fee'], hidden: ['Maker wallet', 'Private balance'] })) return;
      busy = true; updateOrderDialog();
      // Re-read immediately before deriving the key so another tab/order and every
      // unresolved journal reservation participate in the allocation decision.
      options.progress('Syncing order-key reservations');
      await activeSession.sync();
      const activeConnection = connection();
      const latestOrders = await readMarketOrders(activeConnection);
      const reservation = await recoverOrderKeys(activeSession, latestOrders);
      if (options.getSession() !== activeSession || options.getConnection() !== activeConnection) {
        throw new Error('Wallet changed; review the order again');
      }
      if (reservation.next === null) throw new Error(`All ${ORDER_KEY_RECOVERY_LIMIT.toLocaleString('en-US')} deterministic order keys are already reserved`);
      await activeSession.placeOrder({ ...amounts, keyIndex: reservation.next }, options.progress);
      orderForm.reset(); orderDialog.close(); marketView = 'mine'; await options.onComplete();
    } catch (error) { setError(orderForm, error); }
    finally { options.onSettled?.(); busy = false; updateOrderDialog(); renderMarket(); }
  })(); });

  fillForm.addEventListener('input', updateFillDialog);
  fillForm.addEventListener('submit', event => { event.preventDefault(); void (async () => {
    clearError(fillForm);
    try {
      options.prepareSubmission?.();
      const activeSession = session();
      if (fillId === null) throw new Error('Select an order first');
      await refreshOrdersForAction([fillId]);
      updateFillDialog();
      const order = activeFill(); const result = currentFillAmounts();
      if (!order || !order.open) throw new Error('This order is no longer open');
      if (!result) throw new Error('Enter an amount');
      if (result.bought > order.remaining) throw new Error(`The order has only ${formatTradingAmount(orderSxRemaining(order), symbols()[0])} left`);
      const payAsset: Asset = isListing(order) ? 1 : 0;
      if (result.pay <= feeFor(payAsset)) throw new Error(`A fill must pay more than ${formatTradingAmount(feeFor(payAsset), symbols()[payAsset])}`);
      if (result.totalPay > budget(payAsset)) throw new Error('The payment plus protocol fee exceeds your available private notes');
      if (result.leavesDust) throw new Error('That would leave too little in the order to release. Buy all of it, or less');
      const [token, native] = symbols();
      if (!await options.confirm(`Fill order #${order.id}`, [
        ['You pay', formatTradingAmount(result.pay, payAsset === 0 ? token : native)],
        ['Protocol fee', marketVersion() === 2 ? formatTradingAmount(result.protocolFee, payAsset === 0 ? token : native) : 'Not charged on Market V1'],
        ['You receive', formatTradingAmount(result.bought, order.sellAsset === 0 ? token : native)],
      ], { public: ['Order', 'Fill size', 'Fee'], hidden: ['Filler wallet', 'Private output'] })) return;
      busy = true; updateFillDialog();
      assertReviewedMarketOrders([order], await refreshOrdersForAction([order.id]));
      await activeSession.fillOrder({ orderId: order.id, sellAsset: order.sellAsset, pay: result.pay, protocolFee: result.protocolFee }, options.progress);
      fillForm.reset(); fillId = null; fillDialog.close(); await options.onComplete();
    } catch (error) { setError(fillForm, error); }
    finally { options.onSettled?.(); busy = false; updateFillDialog(); renderMarket(); }
  })(); });

  marketExtras.sweepOpen.addEventListener('click', () => {
    marketExtras.sweepForm.reset(); clearError(marketExtras.sweepForm); updateSweepDialog(); marketExtras.sweepDialog.showModal();
    formField(marketExtras.sweepForm, 'amount').focus();
  });
  marketExtras.sweepForm.addEventListener('input', updateSweepDialog);
  marketExtras.sweepForm.addEventListener('submit', event => { event.preventDefault(); void (async () => {
    clearError(marketExtras.sweepForm);
    try {
      options.prepareSubmission?.();
      const activeSession = session(); await refresh();
      if (marketVersion() !== 2 || marketFeeBps === null) throw new Error('Market protocol fee is unavailable; refresh and review the sweep again');
      updateSweepDialog();
      const quote = sweepQuote;
      if (!quote) throw new Error('No open listings can fill that amount');
      await refreshOrdersForAction(quote.fills.map(fill => fill.orderId));
      for (const fill of quote.fills) {
        const order = orders.find(order => order.id === fill.orderId);
        const freshBought = order && order.buyAmount > 0n ? fill.pay * order.sellAmount / order.buyAmount : 0n;
        const remaining = order ? order.remaining - freshBought : 0n;
        if (!order?.open || order.sellAsset !== 0 || order.buyAmount <= 0n
          || freshBought > order.remaining || freshBought !== fill.bought
          || (remaining > 0n && remaining <= feeFor(0))) {
          updateSweepDialog();
          throw new Error('A selected listing changed; review the sweep again');
        }
      }
      const reviewedOrders = quote.fills.map(fill => orders.find(order => order.id === fill.orderId)!);
      if (quote.totalPay > budget(1)) throw new Error(`This sweep needs ${formatTradingAmount(quote.totalPay, symbols()[1])}`);
      const minBought = quote.bought * (10_000n - slippageBps) / 10_000n;
      const [token, native] = symbols();
      if (!await options.confirm(`Sweep ${quote.fills.length} listing${quote.fills.length === 1 ? '' : 's'}`, [
        ['Trade principal', formatTradingAmount(quote.pay, native)],
        ['Protocol fee', formatTradingAmount(quote.protocolFee, native)],
        ['Actual received', formatTradingAmount(quote.bought, token)],
        ['Minimum received', formatTradingAmount(minBought, token)],
      ], { public: ['Orders', 'Fill sizes', 'Fees'], hidden: ['Filler wallet', 'Private output'] })) return;
      busy = true; updateSweepDialog();
      assertReviewedMarketOrders(reviewedOrders, await refreshOrdersForAction(quote.fills.map(fill => fill.orderId)));
      await activeSession.sweepOrders({ fills: quote.fills.map(fill => ({ orderId: fill.orderId, pay: fill.pay })), minBought, protocolFee: quote.protocolFee }, options.progress);
      marketExtras.sweepForm.reset(); marketExtras.sweepDialog.close(); await options.onComplete();
    } catch (error) { setError(marketExtras.sweepForm, error); }
    finally { options.onSettled?.(); busy = false; updateSweepDialog(); renderMarket(); }
  })(); });

  byId('market-tabs').addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-view]');
    if (!button) return; marketView = button.dataset.view as View; renderMarket();
  });
  byId<HTMLSelectElement>('market-sort').addEventListener('change', event => { marketSort = (event.currentTarget as HTMLSelectElement).value as Sort; renderMarket(); });
  marketExtras.range.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-range]');
    if (!button) return;
    marketRange = button.dataset.range as MarketRange;
    for (const choice of marketExtras.range.querySelectorAll<HTMLButtonElement>('button[data-range]')) {
      const selected = choice === button; choice.classList.toggle('active', selected); choice.setAttribute('aria-pressed', String(selected));
    }
    const activeConnection = options.getConnection(); if (activeConnection) void refreshMarketData(activeConnection);
  });
  byId('book-refresh').addEventListener('click', () => { void refresh().catch(error => { byId('my-orders-error').textContent = error instanceof Error ? error.message : String(error); }); });
  for (const close of document.querySelectorAll<HTMLButtonElement>('#order-dialog [data-close], #fill-dialog [data-close], #sweep-dialog [data-close]')) close.addEventListener('click', () => close.closest<HTMLDialogElement>('dialog')?.close());

  const renderBalances = (): void => { updateSwap(); updateOrderDialog(); updateFillDialog(); if (marketExtras.sweepDialog.open) updateSweepDialog(); };
  updateSwap(); updateOrderDialog(); renderMarket(); renderMarketData();
  return { refresh, renderBalances };
}
