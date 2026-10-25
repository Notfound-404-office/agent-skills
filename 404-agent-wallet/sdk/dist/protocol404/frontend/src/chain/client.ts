import { createPublicClient, getContract, http, isAddressEqual, zeroAddress, type Hex, type WalletClient } from 'viem';
import { marketV2, rawAbis } from '../abi/index.ts';
import { create404Config, nativeUnitWei } from '../config/index.ts';
import { getConnectedWalletAccount, walletSigningAccount } from '../wallet/providers.ts';

export const nftGateAbi = [
  { type: 'function', name: 'pool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'membershipNft', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'mintedBy', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'privateMint', stateMutability: 'nonpayable', inputs: rawAbis.mint.find(item => item.type === 'function' && item.name === 'privateMint')!.inputs, outputs: [] },
] as const;

const membershipNftAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const;

export type AppConfig = ReturnType<typeof create404Config>;

/** @orig index-CVtw0LZh.js:28017 EO.open Verify RPC, deployed code and cross-chain signing boundaries. */
export async function openPool(config: AppConfig) {
  const client = createPublicClient({ chain: config.chain, transport: http(config.chain.rpcUrls.default.http[0]), ccipRead: false });
  if (await client.getChainId() !== config.chain.id) throw new Error('RPC chain ID does not match configuration');
  for (const [name, address] of Object.entries(config.contracts)) {
    if (!address) continue;
    const code = await client.getCode({ address });
    if (!code || code === '0x') throw new Error(`No deployed contract code for ${name}`);
  }
  try {
    const assetIdBits = await client.readContract({ address: config.contracts.pool, abi: rawAbis.pool, functionName: 'ASSET_ID_BITS' });
    if (assetIdBits !== 32) throw new Error('wrong width');
  } catch {
    throw new Error('Pool deployment is incompatible: ASSET_ID_BITS() must return 32; a new deployment is required');
  }
  const pool = getContract({ address: config.contracts.pool, abi: rawAbis.pool, client });
  const market = getContract({ address: config.contracts.market, abi: rawAbis.market, client });
  const token = getContract({ address: config.contracts.token, abi: rawAbis.token, client });
  if (!isAddressEqual(await pool.read.token(), config.contracts.token)) throw new Error('Pool token differs from configured token');
  for (const [actual, expected] of [
    [await pool.read.eip712Domain(), config.domains.pool],
    [await market.read.eip712Domain(), config.domains.market],
  ] as const) {
    if (actual[1] !== expected.name || actual[2] !== expected.version || actual[3] !== BigInt(expected.chainId)
      || !isAddressEqual(actual[4], expected.verifyingContract)) throw new Error('On-chain EIP-712 domain differs from configuration');
  }
  if (await token.read.decimals() !== config.tokenDecimals) throw new Error('Token precision differs from protocol configuration');
  if (config.marketVersion === 2) {
    const bps = await client.readContract({ address: config.contracts.market, abi: marketV2, functionName: 'feeBps' });
    if (Number(bps) > 1000) throw new Error('Unsupported MarketV2 fee');
  }
  if (config.mintPolicy?.mode === 'nft-self') {
    const [gatePool, membershipNft] = await Promise.all([
      client.readContract({ address: config.contracts.mint, abi: nftGateAbi, functionName: 'pool' }),
      client.readContract({ address: config.contracts.mint, abi: nftGateAbi, functionName: 'membershipNft' }),
    ]);
    if (!isAddressEqual(gatePool, config.contracts.pool) || !isAddressEqual(membershipNft, config.mintPolicy.nft)) {
      throw new Error('NFT mint gate differs from configured pool or membership NFT');
    }
  }
  return { client, pool, token, config };
}

export type PoolConnection = Awaited<ReturnType<typeof openPool>>;

export async function readNftMintAccess(connection: PoolConnection, account: `0x${string}`) {
  const policy = connection.config.mintPolicy;
  if (policy?.mode !== 'nft-self') throw new Error('NFT self-mint is not configured');
  const [balance, minted] = await Promise.all([
    connection.client.readContract({ address: policy.nft, abi: membershipNftAbi, functionName: 'balanceOf', args: [account] }),
    connection.client.readContract({ address: connection.config.contracts.mint, abi: nftGateAbi, functionName: 'mintedBy', args: [account] }),
  ]);
  return { balance, minted, remaining: minted < 10n ? 10n - minted : 0n };
}

export async function claimTestNft(connection: PoolConnection, wallet: WalletClient, assertCurrent?: () => void) {
  const policy = connection.config.mintPolicy;
  if (policy?.mode !== 'nft-self' || connection.config.chain.id !== 11155111) throw new Error('Test NFT claim is only available on the Sepolia NFT test pool');
  const account = await getConnectedWalletAccount(wallet, connection.config.chain.id);
  const { request } = await connection.client.simulateContract({ address: policy.nft, abi: membershipNftAbi, functionName: 'claim', account });
  const gas = await connection.client.estimateContractGas(request);
  assertCurrent?.();
  const hash = await wallet.writeContract({ ...request, gas: gas * 120n / 100n, account: walletSigningAccount(wallet, account), chain: connection.config.chain });
  const receipt = await connection.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`NFT claim reverted: ${hash}`);
  return receipt;
}

/** Sepolia test fees: user-approved 1-gwei priority floor and 5-gwei maximum-fee floor. */
export async function publicWriteFees(connection: PoolConnection): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  if (connection.config.chain.id !== 11155111) return {};
  const fees = await connection.client.estimateFeesPerGas({ type: 'eip1559' });
  return {
    maxFeePerGas: fees.maxFeePerGas < 5_000_000_000n ? 5_000_000_000n : fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas < 1_000_000_000n ? 1_000_000_000n : fees.maxPriorityFeePerGas,
  };
}

async function assertReviewedAccount(wallet: WalletClient, chainId: number, reviewed: `0x${string}`): Promise<void> {
  if (!isAddressEqual(await getConnectedWalletAccount(wallet, chainId), reviewed)) {
    throw new Error('The connected wallet account changed; reconnect and review again');
  }
}

/** @orig index-CVtw0LZh.js:28787 OO Read live sale/accounting data, never fabricate balances. */
export async function readPoolInfo(connection: PoolConnection) {
  const { pool, token, client } = connection;
  const [lot, price, maxPerTx, maxLots, mintStart, mintedLots, pausedUntil, mintProceeds, treasury, symbol, decimals, tokenPoolBalance, nativePoolBalance, block] = await Promise.all([
    pool.read.lot(), pool.read.price(), pool.read.maxPerTx(), pool.read.maxLots(), pool.read.mintStart(),
    pool.read.mintedLots(), pool.read.pausedUntil(), pool.read.mintProceeds(), pool.read.treasury(), token.read.symbol(),
    token.read.decimals(), pool.read.poolBalance([0n]), pool.read.poolBalance([1n]), client.getBlock(),
  ]);
  return { lot, price, maxPerTx, maxLots, mintStart, mintedLots, pausedUntil, mintProceeds, treasury, symbol, decimals, tokenPoolBalance, nativePoolBalance, now: block.timestamp };
}

/** Sweep only public mint proceeds to the pool's fixed treasury; the contract permits any caller. */
export async function sweepProceeds(connection: PoolConnection, wallet: WalletClient, assertCurrent?: () => void) {
  const { client, config, pool } = connection;
  const account = await getConnectedWalletAccount(wallet, config.chain.id);
  const [treasury, proceeds] = await Promise.all([pool.read.treasury(), pool.read.mintProceeds()]);
  if (isAddressEqual(treasury, zeroAddress)) throw new Error('Pool treasury is not configured');
  if (proceeds <= 0n) throw new Error('No mint proceeds to sweep');
  const { request } = await client.simulateContract({ address: config.contracts.pool, abi: rawAbis.pool, functionName: 'sweep', account });
  const gas = await client.estimateContractGas(request);
  const fees = await publicWriteFees(connection);
  await assertReviewedAccount(wallet, config.chain.id, account);
  assertCurrent?.();
  const hash = await wallet.writeContract({ ...request, ...fees, type: undefined, gasPrice: undefined, gas: gas * 120n / 100n, account: walletSigningAccount(wallet, account), chain: config.chain });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Sweep reverted: ${hash}`);
  return receipt;
}

/** @orig index-CVtw0LZh.js:28678 EO.mint Public mint creates private notes, not ERC-20 balances. */
export async function mintNotes(connection: PoolConnection, wallet: WalletClient, inners: readonly bigint[], ciphertexts: readonly Hex[], assertCurrent?: () => void) {
  const { client, config } = connection;
  if (inners.length !== 1 || ciphertexts.length !== 1) throw new Error('Each mint must be exactly one lot');
  const info = await readPoolInfo(connection);
  if (info.now < info.mintStart || info.mintedLots + BigInt(inners.length) > info.maxLots) throw new Error('Mint not open or sold out');
  const account = await getConnectedWalletAccount(wallet, config.chain.id);
  const { request } = await client.simulateContract({ address: config.contracts.pool, abi: rawAbis.pool, functionName: 'mint', args: [inners, ciphertexts], value: info.price * BigInt(inners.length), account });
  const gas = await client.estimateContractGas(request);
  const fees = await publicWriteFees(connection);
  await assertReviewedAccount(wallet, config.chain.id, account);
  assertCurrent?.();
  const hash = await wallet.writeContract({ ...request, ...fees, type: undefined, gasPrice: undefined, gas: gas * 120n / 100n, account: walletSigningAccount(wallet, account), chain: config.chain });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Mint reverted: ${hash}`);
  return receipt;
}

/** @orig index-CVtw0LZh.js:28704 EO.shield Native note units are converted to wei exactly once. */
export async function depositNote(connection: PoolConnection, wallet: WalletClient, asset: 0 | 1, amount: bigint, inner: bigint, ciphertext: Hex, assertCurrent?: () => void) {
  const { client, config, token } = connection;
  if (amount <= 0n || amount >= 1n << 64n) throw new Error('Invalid note amount');
  const account = await getConnectedWalletAccount(wallet, config.chain.id);
  if (asset === 0 && await token.read.allowance([account, config.contracts.pool]) < amount) {
    const { request } = await client.simulateContract({ address: config.contracts.token, abi: rawAbis.token, functionName: 'approve', args: [config.contracts.pool, amount], account });
    const gas = await client.estimateContractGas(request);
    const fees = await publicWriteFees(connection);
    await assertReviewedAccount(wallet, config.chain.id, account);
    assertCurrent?.();
    const hash = await wallet.writeContract({ ...request, ...fees, type: undefined, gasPrice: undefined, gas: gas * 120n / 100n, account: walletSigningAccount(wallet, account), chain: config.chain });
    if ((await client.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error('Token approval reverted');
  }
  const { request } = await client.simulateContract({ address: config.contracts.pool, abi: rawAbis.pool, functionName: 'shield', args: [asset, amount, inner, ciphertext], value: asset === 1 ? amount * nativeUnitWei : 0n, account });
  const gas = await client.estimateContractGas(request);
  const fees = await publicWriteFees(connection);
  await assertReviewedAccount(wallet, config.chain.id, account);
  assertCurrent?.();
  const hash = await wallet.writeContract({ ...request, ...fees, type: undefined, gasPrice: undefined, gas: gas * 120n / 100n, account: walletSigningAccount(wallet, account), chain: config.chain });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Shield reverted: ${hash}`);
  return receipt;
}
