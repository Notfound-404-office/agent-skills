import {
  encodeAbiParameters, encodeFunctionData, isAddressEqual, keccak256,
  zeroAddress, zeroHash, type Address, type Hex, type WalletClient,
} from 'viem';
import { marketV2, rawAbis } from '../abi/index.ts';
import { nativeUnitWei } from '../config/index.ts';
import { publicWriteFees, readNftMintAccess, type PoolConnection } from '../chain/client.ts';
import { getConnectedWalletAccount, walletSigningAccount } from '../wallet/providers.ts';
// Pure request validation is shared with the historical relay API; no server or signer code.
import {
  validateTransaction, validateMint, validatePlace, validateFill, validateSweep, validateRelease,
  type PrivateTransaction,
} from '../../../relayer/src/validators.ts';

export type AuthorizationPath = '/relay' | '/mint' | '/order' | '/fill' | '/sweep' | '/release' | '/shield';
export type AuthorizationPacket = {
  protocol: '404-authorization'; version: 1; chainId: number; pool: Address;
  path: AuthorizationPath; body: unknown;
};
export type WalletSubmissionOptions = {
  gasPriceWei?: bigint; gasLimit?: bigint;
  beforeSend?: () => Promise<void>; assertCurrent?: () => void;
  onRejected?: () => Promise<void>;
  onStage?: (stage: 'simulating' | 'estimating' | 'wallet') => void;
};
const paths = new Set<string>(['/relay', '/mint', '/order', '/fill', '/sweep', '/release', '/shield']);
const maxPacketLength = 262_144;

function txArgs(tx: PrivateTransaction) {
  return [tx.proof, {
    root: BigInt(tx.pub.root), nullifiers: tx.pub.nullifiers.map(BigInt) as [bigint, bigint],
    commitments: tx.pub.commitments.map(BigInt) as [bigint, bigint], nowTs: BigInt(tx.pub.nowTs),
    asset: Number(tx.pub.asset), publicOut: BigInt(tx.pub.publicOut), fee: BigInt(tx.pub.fee),
  }, tx.ext] as const;
}

function bind(tx: PrivateTransaction, caller: Address, data?: Hex) {
  if (!isAddressEqual(tx.ext.caller, caller)) throw new Error('Authorization caller differs from the configured contract');
  if (caller !== zeroAddress && !isAddressEqual(tx.ext.recipient, caller)) throw new Error('Authorization payment recipient differs from its contract');
  if (data && tx.ext.data.toLowerCase() !== data.toLowerCase()) throw new Error('Authorization operation data was changed');
}

function normalize(connection: PoolConnection, path: string, input: unknown, portable: boolean) {
  if (!paths.has(path)) throw new Error('Unsupported wallet authorization operation');
  const c = connection.config.contracts;
  const v2 = connection.config.marketVersion === 2;
  let body: unknown, tx: PrivateTransaction | undefined, to: Address, data: Hex, value = 0n;
  switch (path) {
    case '/relay': {
      tx = validateTransaction(input); body = tx; bind(tx, zeroAddress, zeroHash);
      to = c.pool; data = encodeFunctionData({ abi: rawAbis.pool, functionName: 'transact', args: txArgs(tx) }); break;
    }
    case '/mint': {
      if (!connection.config.mintPolicy) throw new Error('Use the NFT mint deployment for new mints');
      if (portable && connection.config.mintPolicy.submission !== 'open') throw new Error('This older MintGate binds the submitting wallet; use the open-submission deployment');
      const value = validateMint(input); body = value; tx = value.tx;
      if (tx.pub.asset !== '1') throw new Error('Mint must spend native notes');
      bind(tx, c.mint, keccak256(encodeAbiParameters(
        [{ type: 'uint256[]' }, { type: 'bytes32[]' }],
        [value.mint.inners.map(BigInt), value.mint.ciphertexts.map(value => keccak256(value))],
      )));
      to = c.mint; data = encodeFunctionData({ abi: rawAbis.mint, functionName: 'privateMint', args: [...txArgs(tx), value.mint.inners.map(BigInt), value.mint.ciphertexts] }); break;
    }
    case '/order': {
      const value = validatePlace(input); body = value; tx = value.tx;
      bind(tx, c.market, keccak256(encodeAbiParameters([{ type: 'uint64' }, { type: 'address' }], [BigInt(value.place.buyAmount), value.place.maker])));
      to = c.market; data = encodeFunctionData({ abi: v2 ? marketV2 : rawAbis.market, functionName: 'placeOrder', args: [...txArgs(tx), { buyAmount: BigInt(value.place.buyAmount), maker: value.place.maker }] }); break;
    }
    case '/fill': {
      const value = validateFill(input, v2 ? 2 : 1); body = value; tx = value.tx; const f = value.fill;
      to = c.market;
      if (v2) {
        bind(tx, c.market, keccak256(encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'bytes32' }],
          [BigInt(f.orderId), BigInt(f.pay!), BigInt(f.outInner), keccak256(f.outCiphertext)],
        )));
        data = encodeFunctionData({ abi: marketV2, functionName: 'fillPrivate', args: [...txArgs(tx), { orderId: BigInt(f.orderId), pay: BigInt(f.pay!), outInner: BigInt(f.outInner), outCiphertext: f.outCiphertext }] });
      } else {
        bind(tx, c.market, keccak256(encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [BigInt(f.orderId), BigInt(f.outInner), keccak256(f.outCiphertext)],
        )));
        data = encodeFunctionData({ abi: rawAbis.market, functionName: 'fillPrivate', args: [...txArgs(tx), { orderId: BigInt(f.orderId), outInner: BigInt(f.outInner), outCiphertext: f.outCiphertext }] });
      }
      break;
    }
    case '/sweep': {
      if (!v2) throw new Error('Batch buying requires MarketV2');
      const value = validateSweep(input); body = value; tx = value.tx; const s = value.sweep;
      bind(tx, c.market, keccak256(encodeAbiParameters(
        [{ type: 'uint256[]' }, { type: 'uint64[]' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }],
        [s.orderIds.map(BigInt), s.pays.map(BigInt), BigInt(s.minBought), BigInt(s.boughtInner), keccak256(s.boughtCiphertext), BigInt(s.restInner), keccak256(s.restCiphertext)],
      )));
      to = c.market; data = encodeFunctionData({ abi: marketV2, functionName: 'sweepPrivate', args: [...txArgs(tx), {
        orderIds: s.orderIds.map(BigInt), pays: s.pays.map(BigInt), minBought: BigInt(s.minBought),
        boughtInner: BigInt(s.boughtInner), boughtCiphertext: s.boughtCiphertext, restInner: BigInt(s.restInner), restCiphertext: s.restCiphertext,
      }] }); break;
    }
    case '/shield': {
      const deposit = input as { asset?: unknown; amount?: unknown; inner?: unknown; ciphertext?: unknown };
      if (!deposit || !['0', '1'].includes(String(deposit.asset)) || !/^[0-9]+$/.test(String(deposit.amount ?? ''))
        || !/^[0-9]+$/.test(String(deposit.inner ?? '')) || typeof deposit.ciphertext !== 'string'
        || !/^0x(?:[0-9a-f]{2}){175}$/i.test(deposit.ciphertext)) throw new Error('Deposit authorization has invalid fields');
      const asset = Number(deposit.asset), amount = BigInt(String(deposit.amount)), inner = BigInt(String(deposit.inner));
      if (amount <= 0n || amount >= 1n << 64n || inner >= 21888242871839275222246405745257275088548364400416034343698204186575808495617n) {
        throw new Error('Deposit authorization has invalid amount or inner');
      }
      body = { asset: String(asset), amount: amount.toString(), inner: inner.toString(), ciphertext: deposit.ciphertext };
      to = c.pool;
      data = encodeFunctionData({ abi: rawAbis.pool, functionName: 'shield', args: [asset, amount, inner, deposit.ciphertext as Hex] });
      value = asset === 1 ? amount * nativeUnitWei : 0n;
      break;
    }
    default: {
      const value = validateRelease(input); body = value; const r = value.release;
      if (r.fee !== '0' || !isAddressEqual(r.relayer, zeroAddress)) throw new Error('Wallet authorizations must not pay a relayer');
      to = c.market; data = encodeFunctionData({ abi: v2 ? marketV2 : rawAbis.market, functionName: 'release', args: [value.action, {
        orderId: BigInt(r.orderId), inner: BigInt(r.inner), ciphertext: r.ciphertext, relayer: r.relayer, fee: 0n, deadline: BigInt(r.deadline),
      }, value.signature] });
    }
  }
  if (tx) {
    if (tx.pub.fee !== '0') throw new Error('Wallet authorizations must have zero relayer fee');
    const boundMint = path === '/mint' && !portable && connection.config.mintPolicy?.submission !== 'open';
    if (!boundMint && !isAddressEqual(tx.ext.relayer, zeroAddress)) throw new Error('Authorization is bound to another submitting wallet');
    if (portable && tx.proof.length !== 16_002) throw new Error('Authorization must contain the complete 8000-byte proof');
  }
  return { path: path as AuthorizationPath, body, tx, call: { to, data, value } };
}

export function encodeWalletAction(connection: PoolConnection, path: string, body: unknown) {
  return normalize(connection, path, body, false).call;
}

export function serializeAuthorization(connection: PoolConnection, path: string, body: unknown): string {
  const normalized = normalize(connection, path, body, true);
  return JSON.stringify({ protocol: '404-authorization', version: 1, chainId: connection.config.chain.id,
    pool: connection.config.contracts.pool, path: normalized.path, body: normalized.body } satisfies AuthorizationPacket);
}

export function parseAuthorization(connection: PoolConnection, text: string): AuthorizationPacket {
  if (text.length > maxPacketLength) throw new Error('Authorization package is too large');
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error('Authorization is not valid JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid authorization package');
  const p = input as Record<string, unknown>;
  if (Object.keys(p).some(key => !['protocol', 'version', 'chainId', 'pool', 'path', 'body'].includes(key))
    || p.protocol !== '404-authorization' || p.version !== 1 || p.chainId !== connection.config.chain.id
    || typeof p.pool !== 'string' || !/^0x[0-9a-f]{40}$/i.test(p.pool) || !isAddressEqual(p.pool as Address, connection.config.contracts.pool)
    || typeof p.path !== 'string') throw new Error('Authorization version, chain or pool does not match this page');
  const normalized = normalize(connection, p.path, p.body, true);
  return { protocol: '404-authorization', version: 1, chainId: p.chainId as number,
    pool: connection.config.contracts.pool, path: normalized.path, body: normalized.body };
}

export function describeAuthorization(connection: PoolConnection, text: string) {
  const packet = parseAuthorization(connection, text);
  const normalized = normalize(connection, packet.path, packet.body, true);
  const body = packet.body as { order?: { deadline: string }; release?: { deadline: string } };
  return {
    id: keccak256(encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [BigInt(packet.chainId), packet.pool, normalized.call.to, keccak256(normalized.call.data)],
    )), chainId: packet.chainId, pool: packet.pool,
    target: normalized.call.to, operation: packet.path.slice(1), asset: normalized.tx?.pub.asset,
    publicOut: normalized.tx?.pub.publicOut, deadline: body.order?.deadline ?? body.release?.deadline,
    recipient: normalized.tx && !isAddressEqual(normalized.tx.ext.recipient, zeroAddress) ? normalized.tx.ext.recipient : undefined,
  };
}

export async function submitWalletAction(
  connection: PoolConnection, wallet: WalletClient, path: string, body: unknown, options: WalletSubmissionOptions = {},
): Promise<Hex> {
  const normalized = normalize(connection, path, body, false);
  const account = await getConnectedWalletAccount(wallet, connection.config.chain.id);
  options.assertCurrent?.();
  if (path === '/mint') {
    const access = await readNftMintAccess(connection, account);
    if (access.balance === 0n) throw new Error('The submitting wallet must hold the membership NFT');
    if (access.minted >= 10n) throw new Error('The submitting wallet has reached its 10-mint limit');
    if (connection.config.mintPolicy?.submission !== 'open' && !isAddressEqual(normalized.tx!.ext.relayer, account)) {
      throw new Error('This older MintGate authorization belongs to another wallet');
    }
  }
  const call = { ...normalized.call, account };
  // eth_estimateGas speculatively executes this exact call, so a separate eth_call would
  // repeat the expensive proof verification without adding a validation boundary.
  options.onStage?.('estimating');
  const [estimate, fees] = options.gasPriceWei === undefined
    ? await Promise.all([connection.client.estimateGas(call), publicWriteFees(connection)])
    : [await connection.client.estimateGas(call), undefined] as const;
  const gas = options.gasLimit ?? (estimate * 120n + 99n) / 100n;
  if (gas < estimate || gas > 30_000_000n) throw new Error('Wallet Gas budget is too low or exceeds 30,000,000');
  if (options.gasPriceWei !== undefined && options.gasPriceWei <= 0n) throw new Error('Gas price must be positive');
  options.assertCurrent?.();
  if (!isAddressEqual(await getConnectedWalletAccount(wallet, connection.config.chain.id), account)) throw new Error('Submitting wallet changed; review again');
  options.onStage?.('wallet');
  await options.beforeSend?.();
  options.assertCurrent?.();
  const transaction = { ...normalized.call, account: walletSigningAccount(wallet, account), chain: connection.config.chain, gas };
  try {
    return options.gasPriceWei !== undefined
      ? await wallet.sendTransaction({ ...transaction, gasPrice: options.gasPriceWei })
      : await wallet.sendTransaction({ ...transaction, ...fees });
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; cause && typeof cause === 'object' && depth < 8; depth++) {
      if ((cause as { code?: number }).code === 4001) { await options.onRejected?.(); break; }
      cause = (cause as { cause?: unknown }).cause;
    }
    throw error;
  }
}

export function submitAuthorization(connection: PoolConnection, wallet: WalletClient, text: string, options: WalletSubmissionOptions = {}): Promise<Hex> {
  const packet = parseAuthorization(connection, text);
  return submitWalletAction(connection, wallet, packet.path, packet.body, options);
}
