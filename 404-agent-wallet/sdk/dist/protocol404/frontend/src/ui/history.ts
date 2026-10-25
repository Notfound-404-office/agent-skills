import { formatUnits } from 'viem';
import { readWalletHistory, type HistoryLocalRecord, type HistoryTransaction, type WalletHistoryResult } from '../chain/history.ts';
import type { PoolConnection } from '../chain/client.ts';
import type { PrivateSnapshot } from '../chain/sync.ts';
import type { Protocol404Session } from '../flows/session.ts';
import { marketTransactionUrl } from './trading.ts';

const PAGE_SIZE = 20;

export type WalletHistoryContext = {
  connection: PoolConnection;
  session: Protocol404Session;
  snapshot: PrivateSnapshot;
};

export type WalletHistoryController = { refresh(force?: boolean): Promise<void>; clear(): void };

export type HistoryViewRow = {
  key: string;
  time: number;
  operation: string;
  flows: readonly string[];
  status: string;
  txHash?: string;
  txUrl?: string;
  summary: string;
  localOnly: boolean;
};

function operationLabel(value: string): string {
  return ({
    mint: 'Mint', send: 'Private transfer', unshield: 'Withdraw', shield: 'Deposit',
    merge: 'Merge notes', consolidate: 'Merge notes', place: 'Place order', fill: 'Fill order', sweep: 'Sweep orders',
    release: 'Release order', void: 'Void request', OrderPlaced: 'Place order',
    OrderFilled: 'Fill order', OrderReleased: 'Release order', multiple: 'Multiple actions', market: 'Market action',
  } as Record<string, string>)[value] ?? (value === 'unknown' ? 'Unknown' : value);
}

function flowLines(transaction: HistoryTransaction, token: string, native: string): string[] {
  const result: string[] = [];
  for (const [flow, symbol] of [[transaction.noteFlow.token, token], [transaction.noteFlow.native, native]] as const) {
    const received = BigInt(flow.received);
    const spent = BigInt(flow.spent);
    const net = BigInt(flow.net);
    if (received === 0n && spent === 0n) continue;
    result.push(`Received ${formatUnits(received, 8)} · Spent ${formatUnits(spent, 8)} · Net ${net > 0n ? '+' : ''}${formatUnits(net, 8)} ${symbol}`);
  }
  return result.length ? result : ['No owned-note value'];
}

function transactionSummary(transaction: HistoryTransaction): string {
  const orders = transaction.orderEvents?.map(event => `#${String(event.orderId)} ${operationLabel(event.type)}`) ?? [];
  return [`Block ${transaction.blockNumber}`, ...orders].join(' · ');
}

/** Convert history to display-only rows without treating owned-note change as a recipient transfer amount. */
export function walletHistoryRows(result: WalletHistoryResult, chainId: number, token: string, native: string): HistoryViewRow[] {
  const transactions = result.transactions.map((transaction): HistoryViewRow => ({
    key: `tx:${transaction.txHash}`,
    time: Number(BigInt(transaction.timestamp)) * 1_000,
    operation: operationLabel(transaction.operation),
    flows: flowLines(transaction, token, native),
    status: transaction.status === 'observed' ? 'Observed' : transaction.status,
    txHash: transaction.txHash,
    txUrl: marketTransactionUrl(chainId, transaction.txHash) || undefined,
    summary: transactionSummary(transaction),
    localOnly: false,
  }));
  const local = result.local.map((record): HistoryViewRow => ({
    key: `local:${record.id}`,
    time: record.createdAt,
    operation: operationLabel(typeof record.intent.kind === 'string' ? record.intent.kind : 'unknown'),
    flows: ['Unknown — no matching chain transaction'],
    status: record.status,
    txHash: record.txHash,
    txUrl: record.txHash ? marketTransactionUrl(chainId, record.txHash) || undefined : undefined,
    summary: `Local request ${record.id}`,
    localOnly: true,
  }));
  return [...transactions, ...local].sort((left, right) => right.time - left.time || left.key.localeCompare(right.key));
}

export function historyPage<T>(rows: readonly T[], page: number, pageSize = PAGE_SIZE): { rows: readonly T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  return { rows: rows.slice(safePage * pageSize, (safePage + 1) * pageSize), page: safePage, pages };
}

function contextKey(context: WalletHistoryContext): string {
  const journal = context.session.pendingTransactions().map(record => `${record.id}:${record.status}:${record.txHash ?? ''}`).join('|');
  return `${context.snapshot.head.hash.toLowerCase()}|${journal}`;
}

function sameContext(left: WalletHistoryContext, right: WalletHistoryContext): boolean {
  return left.connection === right.connection && left.session === right.session;
}

type HistoryCoordinatorOptions = {
  getContext: () => WalletHistoryContext | null;
  load: (context: WalletHistoryContext) => Promise<WalletHistoryResult>;
  apply: (result: WalletHistoryResult, context: WalletHistoryContext) => void;
  fail: (error: unknown) => void;
  reset: () => void;
  start?: () => void;
};

/** Owns request deduplication and prevents an old wallet, pool or head from repainting the page. */
export function createHistoryCoordinator(options: HistoryCoordinatorOptions): WalletHistoryController {
  let generation = 0;
  let active: { context: WalletHistoryContext; key: string; promise: Promise<void> } | null = null;
  let loaded: { context: WalletHistoryContext; key: string } | null = null;
  const clear = (): void => { generation++; active = null; loaded = null; options.reset(); };
  const refresh = (force = false): Promise<void> => {
    const context = options.getContext();
    if (!context) { clear(); return Promise.resolve(); }
    const key = contextKey(context);
    if (!force && loaded && sameContext(loaded.context, context) && loaded.key === key) return Promise.resolve();
    if (!force && active && sameContext(active.context, context) && active.key === key) return active.promise;
    const expected = ++generation;
    options.start?.();
    const promise = options.load(context).then(result => {
      const current = options.getContext();
      if (expected === generation && current && sameContext(context, current) && contextKey(current) === key) {
        loaded = { context, key };
        options.apply(result, context);
      }
    }).catch(error => {
      const current = options.getContext();
      if (expected === generation && current && sameContext(context, current) && contextKey(current) === key) options.fail(error);
    }).finally(() => {
      if (active?.promise === promise) active = null;
    });
    active = { context, key, promise };
    return promise;
  };
  return { refresh, clear };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function shortHash(hash: string): string { return `${hash.slice(0, 8)}…${hash.slice(-6)}`; }

export function initWalletHistory(options: {
  getContext: () => WalletHistoryContext | null;
  loader?: (context: WalletHistoryContext) => Promise<WalletHistoryResult>;
}): WalletHistoryController {
  const notes = document.getElementById('notes');
  const notesCard = notes?.closest<HTMLElement>('.card');
  if (!notesCard) throw new Error('Missing Notes card for transaction history');

  const card = node('section', 'card wallet-history');
  card.id = 'wallet-history';
  const head = node('div', 'card-head');
  const title = node('h2', undefined, 'Transaction history');
  title.id = 'wallet-history-title';
  card.setAttribute('aria-labelledby', title.id);
  const refreshButton = node('button', 'small ghost', 'Refresh');
  refreshButton.type = 'button';
  head.append(title, refreshButton);
  const explanation = node('p', 'muted small', 'Owned-note flow may include private change. Observed means found at the verified chain head, not a finality guarantee.');
  const state = node('p', 'muted small', 'Unlock and sync the wallet to load history.');
  state.setAttribute('role', 'status');
  const wrap = node('div', 'table-wrap');
  const table = node('table', 'notes');
  const thead = node('thead');
  const header = node('tr');
  for (const label of ['Time', 'Operation', 'Owned-note flow', 'Status', 'Transaction', 'Block / order']) header.append(node('th', undefined, label));
  thead.append(header);
  const body = node('tbody');
  table.append(thead, body); wrap.append(table);
  const pager = node('div', 'row end');
  const previous = node('button', 'small ghost', 'Previous'); previous.type = 'button';
  const position = node('span', 'muted small', 'Page 1 / 1');
  const next = node('button', 'small ghost', 'Next'); next.type = 'button';
  pager.append(previous, position, next);
  card.append(head, explanation, state, wrap, pager);
  (notesCard.closest('.grid') ?? notesCard).before(card);

  let rows: HistoryViewRow[] = [];
  let page = 0;
  const render = (): void => {
    const current = historyPage(rows, page);
    page = current.page;
    body.replaceChildren(...current.rows.map(row => {
      const tr = node('tr');
      tr.append(node('td', undefined, Number.isFinite(row.time) ? new Date(row.time).toLocaleString() : 'Unknown'));
      tr.append(node('td', undefined, row.operation));
      const flow = node('td', 'maskable');
      for (const line of row.flows) flow.append(node('div', undefined, line));
      tr.append(flow, node('td', undefined, row.localOnly ? `${row.status} · local only` : row.status));
      const transaction = node('td');
      if (row.txHash && row.txUrl) {
        const link = node('a', 'addr maskable', shortHash(row.txHash));
        link.href = row.txUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
        transaction.append(link);
      } else transaction.textContent = '—';
      tr.append(transaction, node('td', undefined, row.summary));
      return tr;
    }));
    const empty = rows.length === 0;
    state.hidden = !empty;
    if (empty && state.textContent === '') state.textContent = 'No wallet history found.';
    wrap.hidden = empty;
    pager.hidden = empty || current.pages === 1;
    position.textContent = `Page ${current.page + 1} / ${current.pages}`;
    previous.disabled = current.page === 0;
    next.disabled = current.page + 1 >= current.pages;
  };

  const controller = createHistoryCoordinator({
    getContext: options.getContext,
    start: () => {
      refreshButton.disabled = true;
      state.hidden = false;
      state.textContent = 'Loading transaction history…';
    },
    load: options.loader ?? (context => readWalletHistory(
      context.connection, context.snapshot, context.session.pendingTransactions(), index => context.session.orderMaker(index),
    )),
    apply: (result, context) => {
      const token = context.connection.config.brand.tokenSymbol;
      const native = context.connection.config.chain.nativeCurrency.symbol;
      rows = walletHistoryRows(result, context.connection.config.chain.id, token, native);
      page = 0;
      state.textContent = rows.length ? '' : 'No wallet history found.';
      refreshButton.disabled = false;
      render();
    },
    fail: error => {
      rows = []; page = 0; refreshButton.disabled = false;
      state.textContent = `History unavailable: ${error instanceof Error ? error.message : String(error)}`;
      render();
    },
    reset: () => {
      rows = []; page = 0; refreshButton.disabled = false;
      state.textContent = 'Unlock and sync the wallet to load history.';
      render();
    },
  });
  refreshButton.addEventListener('click', () => {
    refreshButton.disabled = true; state.hidden = false; state.textContent = 'Loading transaction history…';
    void controller.refresh(true).finally(() => { refreshButton.disabled = false; });
  });
  previous.addEventListener('click', () => { page--; render(); });
  next.addEventListener('click', () => { page++; render(); });
  render();
  return controller;
}
