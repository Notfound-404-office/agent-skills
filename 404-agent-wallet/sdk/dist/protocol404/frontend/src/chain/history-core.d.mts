export type HistoryPageOptions = { offset?: number; limit?: number };

export type HistoryContext = {
  connection: {
    client: {
      getLogs(request: Record<string, unknown>): Promise<any[]>;
      getBlock(request: { blockNumber: bigint }): Promise<{ hash: string; timestamp: bigint }>;
    };
    config: { deployBlock: bigint; contracts: { pool: string; market: string } };
  };
  snapshot: {
    head: { number: bigint; hash: string };
    owned: Array<{ leafIndex: number; cm?: bigint; nf: bigint; note: { asset: number; value: bigint } }>;
    spent: Set<bigint>;
  };
  records?: ReadonlyArray<{
    id: string;
    createdAt: number;
    status: string;
    intent: Record<string, string>;
    txHash?: string;
  }>;
  poolEvents: readonly unknown[];
  marketEvents: readonly unknown[];
  orderMaker(index: number): string | Promise<string>;
};

export type HistoryFlow = { received: string; spent: string; net: string };
export type HistoryLocalRecord = {
  id: string;
  createdAt: number;
  status: string;
  intent: Record<string, string | string[]>;
  txHash?: string;
};
export type HistoryOrderEvent = {
  type: string;
  orderId: string;
  marketAddress: string;
  maker?: string;
  sellAsset?: number;
  sellAmount?: string;
  buyAmount?: string;
  paid?: string;
  bought?: string;
  fee?: string | null;
  shielded?: boolean;
  action?: number;
  amount?: string;
};
export type HistoryTransaction = {
  txHash: string;
  blockNumber: string;
  timestamp: string;
  status: string;
  operation: string;
  noteFlow: { description: string; token: HistoryFlow; native: HistoryFlow };
  marketTypes?: string[];
  marketAddress?: string;
  orderEvents?: HistoryOrderEvent[];
  local?: HistoryLocalRecord[];
};
export type WalletHistoryResult = {
  transactions: HistoryTransaction[];
  local: HistoryLocalRecord[];
  total: number;
  nextOffset: number | null;
  coverage: {
    complete: true;
    fromBlock: string;
    toBlock: string;
    headHash: string;
    orderMakerRange: { from: number; to: number };
    note: string;
  };
};

export function buildHistory(context: HistoryContext, options?: HistoryPageOptions): Promise<WalletHistoryResult>;
