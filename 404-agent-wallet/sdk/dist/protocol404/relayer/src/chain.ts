import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbiItem, type Address, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { protocol404PoolAbi, protocol404BundleAbi, protocol404MarketAbi, protocol404MarketV2Abi, protocol404MintAbi } from "./abi.js";
import { SIGNING_DOMAINS, type RelayerConfig } from "./config.js";
import type { ChainAdapter } from "./service.js";
import type { MarketEvent, TradeSource } from "./trades.js";

const orderPlacedEvent = parseAbiItem("event OrderPlaced(uint256 indexed orderId,address indexed maker,uint32 sellAsset,uint64 sellAmount,uint64 buyAmount)");
const orderFilledV1Event = parseAbiItem("event OrderFilled(uint256 indexed orderId,uint64 paid,uint64 bought,bool shielded)");
const orderFilledV2Event = parseAbiItem("event OrderFilled(uint256 indexed orderId,uint64 paid,uint64 bought,uint64 fee,bool shielded)");

/** Construct a supported-chain viem adapter whose send path is unavailable without an env key. */
export function createChain(config: RelayerConfig): { adapter: ChainAdapter; tradeSource: TradeSource; publicClient: ReturnType<typeof createPublicClient>; relayer: Address; verify(): Promise<void> } {
  const sepolia = config.chainId === 11155111;
  const chain = defineChain({
    id: config.chainId,
    name: sepolia ? "Sepolia" : config.chainId === 56 ? "BNB Smart Chain" : "BNB Smart Chain Testnet",
    nativeCurrency: { name: sepolia ? "Ether" : "BNB", symbol: sepolia ? "ETH" : "BNB", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    testnet: config.chainId !== 56,
  });
  const account = privateKeyToAccount(config.privateKey, { nonceManager });
  const transport = http(config.rpcUrl, { timeout: 20_000 });
  const publicClient = createPublicClient({ chain, transport, ccipRead: false });
  const walletClient = createWalletClient({ account, chain, transport });
  async function rpc<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replaceAll(config.rpcUrl, "[redacted RPC URL]"));
    }
  }

  async function readOrder(orderId: bigint, blockNumber?: bigint) {
      const order = await rpc(() => publicClient.readContract({
        address: config.contracts.market,
        abi: [{
          type: "function", name: "orders", stateMutability: "view",
          inputs: [{ name: "orderId", type: "uint256" }],
          outputs: [{ name: "", type: "tuple", components: [
            { name: "sellAsset", type: "uint32" }, { name: "open", type: "bool" },
            { name: "releases", type: "uint32" }, { name: "maker", type: "address" },
            { name: "sellAmount", type: "uint64" }, { name: "buyAmount", type: "uint64" },
            { name: "remaining", type: "uint64" }, { name: "proceeds", type: "uint64" },
          ] }],
        }] as const,
        functionName: "orders",
        args: [orderId],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      }));
      return { sellAsset: Number(order.sellAsset), releases: Number(order.releases) };
  }

  const adapter: ChainAdapter = {
    readOrder,
    async gasFees() {
      const [gasPrice, block] = await rpc(() => Promise.all([publicClient.getGasPrice(), publicClient.getBlock({ blockTag: "latest" })]));
      return { gasPrice, baseFee: block.baseFeePerGas ?? 0n };
    },
    async call(request) { await rpc(() => publicClient.call(request)); },
    estimateGas(request) { return rpc(() => publicClient.estimateGas(request)); },
    async send(request) {
      const { gasPrice, ...transaction } = request;
      if (gasPrice !== undefined) return rpc(() => walletClient.sendTransaction({ ...transaction, account, type: "legacy", gasPrice }));
      if (!sepolia) return rpc(() => walletClient.sendTransaction({ ...transaction, account }));
      const fees = await rpc(() => publicClient.estimateFeesPerGas({ type: "eip1559" }));
      const maxFeePerGas = fees.maxFeePerGas < 5_000_000_000n ? 5_000_000_000n : fees.maxFeePerGas;
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas < 1_000_000_000n ? 1_000_000_000n : fees.maxPriorityFeePerGas;
      return rpc(() => walletClient.sendTransaction({ ...transaction, account, maxFeePerGas, maxPriorityFeePerGas }));
    },
  };

  const tradeSource: TradeSource = {
    blockNumber: () => rpc(() => publicClient.getBlockNumber()),
    async blockTimestamp(blockNumber) { return Number((await rpc(() => publicClient.getBlock({ blockNumber }))).timestamp); },
    async orderSellAsset(orderId, blockNumber) { return (await readOrder(orderId, blockNumber)).sellAsset; },
    async marketEvents(fromBlock, toBlock) {
      const fillEvent = config.contracts.marketVersion === 2 ? orderFilledV2Event : orderFilledV1Event;
      const [placements, fills] = await rpc(() => Promise.all([
        publicClient.getLogs({ address: config.contracts.market, event: orderPlacedEvent, fromBlock, toBlock }),
        publicClient.getLogs({ address: config.contracts.market, event: fillEvent, fromBlock, toBlock }),
      ]));
      const events: MarketEvent[] = placements.map(log => ({
        kind: "placed", orderId: log.args.orderId!, sellAsset: Number(log.args.sellAsset!),
        block: log.blockNumber, logIndex: log.logIndex,
      }));
      for (const log of fills) {
        const args = log.args as { orderId?: bigint; paid?: bigint; bought?: bigint; fee?: bigint };
        events.push({ kind: "filled", orderId: args.orderId!, paid: args.paid!, bought: args.bought!, fee: args.fee ?? 0n, block: log.blockNumber, logIndex: log.logIndex, tx: log.transactionHash });
      }
      return events;
    },
  };

  return {
    adapter, tradeSource, publicClient,
    relayer: account.address,
    async verify() {
      await rpc(async () => {
        const actualChain = await publicClient.getChainId();
        if (actualChain !== config.chainId) throw new Error(`RPC chain ${actualChain} does not match RELAYER_CHAIN_ID ${config.chainId}`);
        for (const [name, address] of [["pool", config.contracts.pool], ["market", config.contracts.market], ["mint", config.contracts.mint], ["bundle", config.contracts.bundle]] as const) {
          if (!await publicClient.getBytecode({ address })) throw new Error(`${name} has no contract code at ${address}`);
        }
        try {
          const bits = await publicClient.readContract({ address: config.contracts.pool, abi: protocol404PoolAbi, functionName: "ASSET_ID_BITS" });
          if (bits !== 32) throw new Error("wrong width");
        } catch {
          throw new Error("pool deployment is incompatible: ASSET_ID_BITS() must return 32; a new deployment is required");
        }
        const satellites = [
          ["market", config.contracts.market, config.contracts.marketVersion === 2 ? protocol404MarketV2Abi : protocol404MarketAbi],
          ["mint", config.contracts.mint, protocol404MintAbi], ["bundle", config.contracts.bundle, protocol404BundleAbi],
        ] as const;
        for (const [name, address, abi] of satellites) {
          const pool = await publicClient.readContract({ address, abi, functionName: "pool" });
          if (getAddress(pool as Address) !== getAddress(config.contracts.pool)) throw new Error(`${name} points to a different pool`);
        }
        const poolDomain = SIGNING_DOMAINS[config.signingProfiles.pool].pool;
        const marketDomain = SIGNING_DOMAINS[config.signingProfiles.market].market;
        const domains = [
          ["pool", config.contracts.pool, protocol404PoolAbi, poolDomain.name, poolDomain.version],
          ["market", config.contracts.market, protocol404MarketAbi, marketDomain.name, marketDomain.version],
        ] as const;
        for (const [label, address, abi, expectedName, expectedVersion] of domains) {
          const domain = await publicClient.readContract({ address, abi, functionName: "eip712Domain" });
          const [, name, version, domainChainId, verifyingContract] = domain;
          if (name !== expectedName || version !== expectedVersion || domainChainId !== BigInt(config.chainId) || getAddress(verifyingContract) !== getAddress(address)) {
            throw new Error(`${label} EIP-712 domain does not match the configured signing profile`);
          }
        }
      });
    },
  };
}
