import { marketAbi, rawAbis } from '../abi/index.ts';
import type { JournalRecord } from '../flows/journal.ts';
import type { PoolConnection } from './client.ts';
import { buildHistory, type HistoryPageOptions, type WalletHistoryResult } from './history-core.mjs';
import type { PrivateSnapshot } from './sync.ts';

export type { HistoryFlow, HistoryLocalRecord, HistoryOrderEvent, HistoryPageOptions, HistoryTransaction, WalletHistoryResult } from './history-core.mjs';

/** Read wallet history from an existing verified snapshot; this never performs another private sync. */
export function readWalletHistory(
  connection: PoolConnection,
  snapshot: PrivateSnapshot,
  records: readonly JournalRecord[],
  orderMaker: (index: number) => `0x${string}`,
  options?: HistoryPageOptions,
): Promise<WalletHistoryResult> {
  return buildHistory({
    connection,
    snapshot,
    records: [...records],
    poolEvents: rawAbis.pool.filter(entry => entry.type === 'event' && ['NoteAdded', 'Nullified'].includes(entry.name)),
    marketEvents: marketAbi(connection.config.marketVersion).filter(entry => entry.type === 'event' && ['OrderPlaced', 'OrderFilled', 'OrderReleased'].includes(entry.name)),
    orderMaker,
  }, options);
}
