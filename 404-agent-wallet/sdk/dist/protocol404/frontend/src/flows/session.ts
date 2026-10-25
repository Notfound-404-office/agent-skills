import {
  bytesToHex, concatHex, encodeAbiParameters, encodeFunctionData, hexToBytes, isAddress, isAddressEqual, keccak256, numberToHex,
  zeroAddress, zeroHash, type Address, type Hex, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { marketV2, rawAbis } from '../abi/index.ts';
import { LEGACY_PAYMENT_LOCK_PREFIX } from '../compatibility.ts';
import { nativeUnitWei } from '../config/index.ts';
import { readNftMintAccess, type PoolConnection } from '../chain/client.ts';
import { getConnectedWalletAccount } from '../wallet/providers.ts';
import { syncPrivateNotes, type PrivateSnapshot, type VerifiedCheckpointStore } from '../chain/sync.ts';
import {
  addressOwner, buildTransferWitness, bytesToBigInt, createDummyOutput, createNote, deriveAddress, deriveBytes,
  deriveNoteSecrets, encodePrivateAddress, encryptNote, encryptOutgoingNote, externalDataHash,
  noteCommitment, noteInner, type Asset, type KeyMaterial, type NoteOutput, type PrivateAddress,
} from '../crypto/index.ts';
import { type FeePreferences, type RelayOperation, type RelayPath } from '../relayer-client/index.ts';
import { IndexedDbJournalStore, PendingJournal, type JournalRecord, type JournalStore } from './journal.ts';
import { serializeAuthorization, submitWalletAction } from './portable.ts';

export type TransferProver = {
  proveTransfer(inputs: Record<string, unknown>): Promise<{ proof: Hex; publicInputs?: readonly Hex[] }>;
};

export type Progress = (message: string) => void;
export type SessionOptions = {
  checkpointStore?: VerifiedCheckpointStore;
  journalStore?: JournalStore;
  lock?: <T>(name: string, operation: () => Promise<T>) => Promise<T>;
  rng?: (length: number) => Uint8Array;
  waitForObservation?: boolean;
  observationTimeoutMs?: number;
  observationIntervalMs?: number;
  signal?: AbortSignal;
  feePreferences?: (request: Readonly<{ operation: RelayOperation; count?: number }>) => FeePreferences | Promise<FeePreferences>;
  getWallet?: () => WalletClient | undefined;
  submissionMode?: () => 'submit' | 'export';
  onAuthorization?: (text: string, record: JournalRecord) => void | Promise<void>;
  assertCurrent?: () => void;
};

export class UnknownSubmissionError extends Error {
  readonly journalId: string;
  constructor(journalId: string, reason: unknown) {
    super(`outcome unknown (${journalId}): ${reason instanceof Error ? reason.message : String(reason)}`);
    this.journalId = journalId;
  }
}

export class SubmittedPendingError extends Error {
  readonly hash: Hex;
  readonly journalId: string;
  readonly lastSyncError?: unknown;
  constructor(hash: Hex, journalId: string, cause?: unknown) {
    super(`submitted ${hash}, not yet seen on chain (${journalId}). Do not pay again; use Pending requests.`, cause === undefined ? undefined : { cause });
    this.hash = hash;
    this.journalId = journalId;
    this.lastSyncError = cause;
  }
}

type PrivateTransaction = {
  proof: Hex;
  pub: { root: string; nullifiers: [string, string]; commitments: [string, string]; nowTs: string; asset: string; publicOut: string; fee: string };
  ext: { recipient: Address; relayer: Address; caller: Address; data: Hex; ciphertexts: [Hex, Hex] };
};

type ContractDetails =
  | { kind: 'mint'; mint: { inners: string[]; ciphertexts: Hex[] } }
  | { kind: 'place'; place: { buyAmount: string; maker: Address } }
  | { kind: 'fill'; fill: { orderId: string; pay?: string; outInner: string; outCiphertext: Hex } }
  | { kind: 'sweep'; sweep: { orderIds: string[]; pays: string[]; minBought: string; boughtInner: string; boughtCiphertext: Hex; restInner: string; restCiphertext: Hex } };
type Prepared = { tx: PrivateTransaction; nullifiers: bigint[]; contract?: ContractDetails };
type SignedRelease = {
  action: 0 | 1;
  release: { orderId: string; inner: string; ciphertext: Hex; relayer: Address; fee: string; deadline: string };
  signature: Hex;
};


const SECP256K1_ORDER = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

/** @orig index-CVtw0LZh.js:26421 FE Canonical digest emitted by Protocol404Pool.Transacted. */
function requestDigest(connection: PoolConnection, tx: PrivateTransaction): Hex {
  const context = { chainId: BigInt(connection.config.chain.id), pool: hexToBytes(connection.config.contracts.pool) };
  const extHash = externalDataHash(context, {
    recipient: hexToBytes(tx.ext.recipient), relayer: hexToBytes(tx.ext.relayer), caller: hexToBytes(tx.ext.caller),
    data: hexToBytes(tx.ext.data), ciphertexts: tx.ext.ciphertexts.map(value => hexToBytes(value)) as [Uint8Array, Uint8Array],
  });
  return keccak256(concatHex([
    tx.pub.root, ...tx.pub.nullifiers, ...tx.pub.commitments, tx.pub.nowTs, tx.pub.asset, tx.pub.publicOut, tx.pub.fee,
    extHash.toString(),
  ].map(value => numberToHex(BigInt(value), { size: 32 }))));
}

function defaultLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('This browser has no safe cross-tab payment lock. Use a browser that supports Web Locks');
  }
  return navigator.locks.request(name, { mode: 'exclusive' }, async () => await operation()) as Promise<T>;
}

function sum(notes: readonly { note: { value: bigint } }[]): bigint {
  return notes.reduce((total, owned) => total + owned.note.value, 0n);
}

/** Select one sufficient note; only use two inputs when one note cannot cover the amount. */
function selectInputs(snapshot: PrivateSnapshot, pending: ReadonlySet<bigint>, amount: bigint, now: bigint, asset: Asset) {
  const spendable = snapshot.unspent
    .filter(owned => owned.note.asset === asset && owned.note.lockUntil <= now && !pending.has(owned.nf))
    .sort((left, right) => left.note.value < right.note.value ? -1 : 1);
  const single = spendable.find(owned => owned.note.value >= amount);
  if (single) return [single];
  let best: typeof spendable | null = null;
  for (let left = 0; left < spendable.length; left++) {
    for (let right = left + 1; right < spendable.length; right++) {
      const pair = [spendable[left]!, spendable[right]!];
      if (sum(pair) >= amount && (!best || sum(pair) < sum(best))) best = pair;
    }
  }
  if (best) return best;
  if (sum(spendable) >= amount) throw new Error('needs more than two notes: consolidate first');
  throw new Error('insufficient spendable balance');
}

/** @orig index-CVtw0LZh.js:28010 EO + :28130 DO Stateful private wallet transaction coordinator. */
export class Protocol404Session {
  readonly connection: PoolConnection;
  readonly keys: KeyMaterial;
  readonly prover: TransferProver;
  readonly address: PrivateAddress;
  readonly journal: PendingJournal;
  private snapshot: PrivateSnapshot | null = null;
  private readonly paymentLock: <T>(name: string, operation: () => Promise<T>) => Promise<T>;
  private readonly rng: (length: number) => Uint8Array;
  private readonly signal?: AbortSignal;
  private readonly waitForObservation: boolean;
  private readonly observationTimeoutMs: number;
  private readonly observationIntervalMs: number;
  private readonly feePreferences: NonNullable<SessionOptions['feePreferences']>;
  private readonly getWallet: NonNullable<SessionOptions['getWallet']>;
  private readonly submissionMode: NonNullable<SessionOptions['submissionMode']>;
  private readonly onAuthorization?: SessionOptions['onAuthorization'];
  private readonly assertCurrent?: SessionOptions['assertCurrent'];
  private readonly checkpointStore?: VerifiedCheckpointStore;

  constructor(
    connection: PoolConnection,
    keys: KeyMaterial,
    prover: TransferProver,
    options: SessionOptions = {},
  ) {
    this.connection = connection;
    this.keys = keys;
    this.prover = prover;
    const pool = connection.config.contracts.pool;
    this.address = deriveAddress(keys, deriveBytes(keys.seed, 'pm/address/0', 11));
    const journalDomain = `pm/journal/v1/${connection.config.chain.id}/${pool.toLowerCase()}`;
    const journalScope = bytesToHex(deriveBytes(keys.seed, `${journalDomain}/id`, 16)).slice(2);
    this.journal = new PendingJournal(keys, connection.config.chain.id, pool, options.journalStore ?? new IndexedDbJournalStore(`${journalScope}:`));
    this.paymentLock = options.lock ?? defaultLock;
    this.rng = options.rng ?? (length => crypto.getRandomValues(new Uint8Array(length)));
    this.waitForObservation = options.waitForObservation ?? true;
    this.observationTimeoutMs = options.observationTimeoutMs ?? 180_000;
    this.observationIntervalMs = options.observationIntervalMs ?? 2_000;
    this.signal = options.signal;
    this.feePreferences = options.feePreferences ?? (() => ({}));
    this.getWallet = options.getWallet ?? (() => undefined);
    this.submissionMode = options.submissionMode ?? (() => 'submit');
    this.onAuthorization = options.onAuthorization;
    this.assertCurrent = options.assertCurrent;
    this.checkpointStore = options.checkpointStore;
  }

  get privateAddress(): string { return encodePrivateAddress(this.address); }

  /** @orig index-CVtw0LZh.js:28186 DO.sync Refresh notes and reconcile durable pending payments. */
  sync(onProgress?: (block: bigint, head: bigint) => void): Promise<PrivateSnapshot> {
    return this.paymentLock(`${LEGACY_PAYMENT_LOCK_PREFIX}${this.journal.scope}`, () => this.syncUnlocked(onProgress));
  }

  pendingTransactions(): JournalRecord[] { return this.journal.list(); }

  /** Observe saved requests; only an exported authorization may be explicitly submitted by the connected wallet. */
  resume(id: string, progress: Progress = () => {}): Promise<Hex | undefined> {
    return this.paymentLock(`${LEGACY_PAYMENT_LOCK_PREFIX}${this.journal.scope}`, async () => {
      progress('Checking the saved request against the chain');
      const snapshot = await this.syncUnlocked();
      return this.resumeUnlocked(id, snapshot, progress);
    });
  }

  /** @orig index-CVtw0LZh.js:28579 EO.voidTransaction Replace a pending request by spending one of its exact inputs. */
  void(id: string, progress: Progress = () => {}): Promise<Hex | undefined> {
    return this.paymentLock(`${LEGACY_PAYMENT_LOCK_PREFIX}${this.journal.scope}`, async () => {
      progress('Checking the original request against the chain');
      const snapshot = await this.syncUnlocked();
      const existing = this.journal.list()
        .filter(record => record.intent.kind === 'void' && record.intent.originalId === id
          && ['prepared', 'exported', 'unknown', 'submitted'].includes(record.status))
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (existing) return this.resumeUnlocked(existing.id, snapshot, progress);
      const original = this.journal.get(id);
      if (original.status === 'observed') throw new Error('the original request is already on chain; it cannot be voided');
      if (original.status === 'conflicted') throw new Error('another transaction spent the original inputs; there is nothing to void');
      if (original.status === 'prepared') { await this.journal.discardPrepared(id); return undefined; }
      const payload = this.primaryTransaction(original);
      if (!payload) throw new Error('this saved request has no private input that can be voided');
      const asset = Number(payload.pub.asset) as Asset;
      if (asset !== 0 && asset !== 1) throw new Error('saved request has an invalid asset');
      const originalNullifiers = new Set(payload.pub.nullifiers.map(BigInt));
      const candidates = snapshot.owned
        .filter(owned => originalNullifiers.has(owned.nf) && owned.note.value > 0n
          && !snapshot.spent.has(owned.nf) && owned.note.lockUntil <= snapshot.head.timestamp)
        .sort((left, right) => left.note.value > right.note.value ? -1 : 1);
      if (!candidates.length) throw new Error('the saved request spends no unspent note of this wallet: nothing to void');
      progress('Proving the cancellation');
      const intent = { kind: 'void', asset: String(asset), originalId: id, voids: id };
      const cancel = await this.prepareTransfer({
        asset, now: snapshot.head.timestamp, fee: 0n, relayer: zeroAddress, caller: zeroAddress, data: zeroHash,
      }, 0n, null, 0n, zeroAddress, [candidates[0]!]);
      return this.submitPrepared(intent, '/relay', cancel.tx, cancel.nullifiers,
        [requestDigest(this.connection, cancel.tx)], false, progress);
    });
  }

  /** @orig index-CVtw0LZh.js:27776 HD.discardUnsent Remove only a locally prepared request that was never posted. */
  discardPrepared(id: string): Promise<void> {
    return this.paymentLock(`${LEGACY_PAYMENT_LOCK_PREFIX}${this.journal.scope}`, async () => {
      await this.journal.load();
      await this.journal.discardPrepared(id);
    });
  }

  async send(
    request: { to: PrivateAddress; amount: bigint; asset?: Asset; memo?: Uint8Array; lockUntil?: bigint },
    progress: Progress = () => {},
  ): Promise<Hex | undefined> {
    return this.execute({ kind: 'send', asset: String(request.asset ?? 0), amount: request.amount.toString(), recipient: encodePrivateAddress(request.to) }, request.asset ?? 0, async context => {
      const output = { to: request.to, note: createNote(request.to, request.amount, { asset: context.asset, memo: request.memo, lockUntil: request.lockUntil, rseed: this.rng(32) }) };
      return this.prepareTransfer(context, request.amount, output, 0n, zeroAddress);
    }, progress);
  }

  async withdraw(
    request: { recipient: Address; amount: bigint; asset?: Asset },
    progress: Progress = () => {},
  ): Promise<Hex | undefined> {
    if (!isAddress(request.recipient, { strict: false })) throw new Error('invalid withdrawal recipient');
    return this.execute({ kind: 'unshield', asset: String(request.asset ?? 0), amount: request.amount.toString(), recipient: request.recipient }, request.asset ?? 0,
      context => this.prepareTransfer(context, request.amount, null, request.amount, request.recipient), progress);
  }

  async lock(request: { amount: bigint; until: bigint }, progress: Progress = () => {}): Promise<Hex | undefined> {
    return this.execute({ kind: 'lock', asset: '0', amount: request.amount.toString(), until: request.until.toString() }, 0, async context => {
      const output = { to: this.address, note: createNote(this.address, request.amount, { asset: 0, lockUntil: request.until, rseed: this.rng(32) }) };
      return this.prepareTransfer(context, request.amount, output, 0n, zeroAddress);
    }, progress);
  }

  async consolidate(request: { asset?: Asset } = {}, progress: Progress = () => {}): Promise<Hex | undefined> {
    const asset = request.asset ?? 0;
    return this.execute({ kind: 'consolidate', asset: String(asset) }, asset, context => {
      const available = this.available(context.asset, context.now).sort((left, right) => left.note.value < right.note.value ? -1 : 1);
      if (available.length < 2) throw new Error('nothing to consolidate');
      return this.prepareTransfer(context, 0n, null, 0n, zeroAddress, available.slice(0, 2));
    }, progress);
  }

  /** Prepare a public-wallet deposit authorization; BAW supplies the native value when needed. */
  async deposit(request: { amount: bigint; asset?: Asset }, progress: Progress = () => {}): Promise<Hex | undefined> {
    const asset = request.asset ?? 0;
    if (request.amount <= 0n || request.amount >= 1n << 64n) throw new RangeError('deposit amount');
    const note = this.sealedNote(this.address, asset, request.amount);
    return this.submitPrepared(
      { kind: 'deposit', asset: String(asset), amount: request.amount.toString() }, '/shield',
      { asset: String(asset), amount: request.amount.toString(), inner: note.inner.toString(), ciphertext: note.ciphertext },
      [], [], false, progress,
    );
  }

  /** @orig index-CVtw0LZh.js:27355 jD.preparePrivateMint Pay native notes and receive private token lots. */
  async privateMint(
    request: { count: number; lot: bigint; priceWei: bigint; to?: PrivateAddress; wallet?: WalletClient; assertCurrent?: () => void },
    progress: Progress = () => {},
  ): Promise<Hex | undefined> {
    if (request.count !== 1) throw new RangeError('each mint must be exactly one lot');
    const totalWei = request.priceWei * BigInt(request.count);
    if (totalWei % nativeUnitWei !== 0n) throw new Error('the mint price is not a whole number of native units');
    const policy = this.connection.config.mintPolicy;
    const submission = (policy as { submission?: 'bound' | 'open' } | undefined)?.submission ?? 'bound';
    if (policy?.mode === 'nft-self' && submission === 'bound') {
      if (this.submissionMode() === 'export') {
        throw new Error('This Mint proof is bound to its submitting wallet and cannot be exported; use an open Mint pool');
      }
      return this.boundPrivateMint(request, totalWei, progress);
    }
    const router = this.connection.config.contracts.mint;
    return this.execute({ kind: 'mint', asset: '1', amount: (totalWei / nativeUnitWei).toString(), count: String(request.count) }, 1, async context => {
      const lots = Array.from({ length: request.count }, () => this.sealedNote(request.to ?? this.address, 0, request.lot));
      const mint = { inners: lots.map(lot => lot.inner.toString()), ciphertexts: lots.map(lot => lot.ciphertext) };
      const data = keccak256(encodeAbiParameters(
        [{ type: 'uint256[]' }, { type: 'bytes32[]' }],
        [lots.map(lot => lot.inner), lots.map(lot => keccak256(lot.ciphertext))],
      ));
      return { ...(await this.prepareTransfer({ ...context, caller: router, data }, totalWei / nativeUnitWei, null, totalWei / nativeUnitWei, router)), contract: { kind: 'mint', mint } };
    }, progress);
  }

  private boundPrivateMint(
    request: { count: number; lot: bigint; priceWei: bigint; to?: PrivateAddress; wallet?: WalletClient; assertCurrent?: () => void },
    totalWei: bigint,
    progress: Progress,
  ): Promise<Hex | undefined> {
    const wallet = request.wallet ?? this.getWallet();
    if (!wallet) throw new Error('Connect a public wallet to submit the NFT-gated mint');
    return this.paymentLock(`${LEGACY_PAYMENT_LOCK_PREFIX}${this.journal.scope}`, async () => {
      progress('Syncing private notes');
      const snapshot = await this.syncUnlocked();
      const account = await getConnectedWalletAccount(wallet, this.connection.config.chain.id);
      request.assertCurrent?.();
      const access = await readNftMintAccess(this.connection, account);
      if (access.balance === 0n) throw new Error('This wallet does not hold the required membership NFT');
      if (access.minted >= 10n) throw new Error('This wallet has reached its 10-mint limit');
      const router = this.connection.config.contracts.mint;
      const lot = this.sealedNote(request.to ?? this.address, 0, request.lot);
      const mint = { inners: [lot.inner.toString()], ciphertexts: [lot.ciphertext] };
      const data = keccak256(encodeAbiParameters(
        [{ type: 'uint256[]' }, { type: 'bytes32[]' }],
        [[lot.inner], [keccak256(lot.ciphertext)]],
      ));
      progress('Making the zero-fee mint proof');
      const prepared = await this.prepareTransfer(
        { asset: 1, now: snapshot.head.timestamp, fee: 0n, relayer: account, caller: router, data },
        totalWei / nativeUnitWei, null, totalWei / nativeUnitWei, router,
      );
      const body = { tx: prepared.tx, mint };
      return this.submitPrepared(
        { kind: 'mint', asset: '1', amount: (totalWei / nativeUnitWei).toString(), count: '1' },
        '/mint', body, prepared.nullifiers, [requestDigest(this.connection, prepared.tx)], false, progress,
        wallet, async () => {
          request.assertCurrent?.();
          this.assertCurrent?.();
          if (!isAddressEqual(await getConnectedWalletAccount(wallet, this.connection.config.chain.id), account)) {
            throw new Error('wallet account changed before submission');
          }
        },
      );
    });
  }

  /** @orig index-CVtw0LZh.js:27377 jD.orderKey Deterministically derive the isolated secp256k1 maker key. */
  orderKey(index: number): Hex {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('order key index');
    const market = this.connection.config.contracts.market.toLowerCase();
    const info = `pm/order-key/v2/${this.connection.config.chain.id}/${market}/${index}`;
    const scalar = bytesToBigInt(deriveBytes(this.keys.seed, info, 64)) % (SECP256K1_ORDER - 1n) + 1n;
    return `0x${scalar.toString(16).padStart(64, '0')}`;
  }

  /** @orig index-CVtw0LZh.js:27385 jD.orderMaker Return the public maker address for an isolated order key. */
  orderMaker(index: number): Address { return privateKeyToAccount(this.orderKey(index)).address; }

  /** @orig index-CVtw0LZh.js:27388 jD.prepareOrder Build a private market order placement. */
  async placeOrder(
    request: { sellAsset: Asset; sellAmount: bigint; buyAmount: bigint; keyIndex: number },
    progress: Progress = () => {},
  ): Promise<Hex | undefined> {
    const market = this.connection.config.contracts.market;
    if (this.connection.config.marketVersion === 2 && (request.sellAmount <= 0n || request.sellAmount >= 1n << 64n
      || request.buyAmount <= 0n || request.buyAmount >= 1n << 63n)) throw new RangeError('market order amount');
    return this.execute({ kind: 'place', asset: String(request.sellAsset), amount: request.sellAmount.toString() }, request.sellAsset, async context => {
      const place = { buyAmount: request.buyAmount.toString(), maker: this.orderMaker(request.keyIndex) };
      const data = keccak256(encodeAbiParameters([{ type: 'uint64' }, { type: 'address' }], [request.buyAmount, place.maker]));
      return { ...(await this.prepareTransfer({ ...context, caller: market, data }, request.sellAmount, null, request.sellAmount, market)), contract: { kind: 'place', place } };
    }, progress);
  }

  /** @orig index-CVtw0LZh.js:27406 jD.prepareFill Build a private order fill and open-value payout note. */
  async fillOrder(
    request: { orderId: bigint; sellAsset: Asset; pay: bigint; protocolFee?: bigint },
    progress: Progress = () => {},
  ): Promise<Hex | undefined> {
    const market = this.connection.config.contracts.market;
    const payAsset = request.sellAsset === 0 ? 1 : 0;
    if (request.pay <= 0n || request.pay >= 1n << 64n) throw new RangeError('fill payment');
    const version2 = this.connection.config.marketVersion === 2;
    const protocolFee = request.pay * BigInt(await this.marketFeeBps()) / 10_000n;
    if (request.protocolFee !== undefined && request.protocolFee !== protocolFee) throw new Error('Market fee changed; review the fill again');
    const amount = request.pay + protocolFee;
    if (amount >= 1n << 64n) throw new RangeError('fill payment including fee');
    return this.execute({ kind: 'fill', asset: String(payAsset), amount: amount.toString() }, payAsset, async context => {
      const output = this.openDeposit(request.sellAsset);
      const fill = { orderId: request.orderId.toString(), ...(version2 ? { pay: request.pay.toString() } : {}), outInner: output.inner.toString(), outCiphertext: output.ciphertext };
      const data = version2 ? keccak256(encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'bytes32' }],
        [request.orderId, request.pay, output.inner, keccak256(output.ciphertext)],
      )) : keccak256(encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
        [request.orderId, output.inner, keccak256(output.ciphertext)],
      ));
      return { ...(await this.prepareTransfer({ ...context, caller: market, data }, amount, null, amount, market)), contract: { kind: 'fill', fill } };
    }, progress);
  }

  /** Buy up to twenty listings atomically with one native payment proof and one token output note. */
  async sweepOrders(
    request: { fills: readonly { orderId: bigint; pay: bigint }[]; minBought: bigint; protocolFee?: bigint },
    progress: Progress = () => {},
  ): Promise<Hex | undefined> {
    if (this.connection.config.marketVersion !== 2) throw new Error('Batch buying requires MarketV2');
    if (request.fills.length < 1 || request.fills.length > 20
      || new Set(request.fills.map(fill => fill.orderId.toString())).size !== request.fills.length
      || request.fills.some(fill => fill.orderId < 0n || fill.orderId >= 1n << 256n || fill.pay <= 0n || fill.pay >= 1n << 64n)
      || request.minBought <= 0n || request.minBought >= 1n << 64n) throw new RangeError('batch purchase');
    const feeBps = BigInt(await this.marketFeeBps());
    const protocolFee = request.fills.reduce((total, fill) => total + fill.pay * feeBps / 10_000n, 0n);
    if (request.protocolFee !== undefined && request.protocolFee !== protocolFee) throw new Error('Market fee changed; review the batch purchase again');
    const amount = request.fills.reduce((total, fill) => total + fill.pay, protocolFee);
    if (amount >= 1n << 64n) throw new RangeError('batch payment including fee');
    const market = this.connection.config.contracts.market;
    return this.execute({ kind: 'sweep', asset: '1', amount: amount.toString() }, 1, async context => {
      const bought = this.openDeposit(0);
      const rest = this.openDeposit(1);
      const orderIds = request.fills.map(fill => fill.orderId);
      const pays = request.fills.map(fill => fill.pay);
      const sweep = {
        orderIds: orderIds.map(String), pays: pays.map(String), minBought: request.minBought.toString(),
        boughtInner: bought.inner.toString(), boughtCiphertext: bought.ciphertext,
        restInner: rest.inner.toString(), restCiphertext: rest.ciphertext,
      };
      const data = keccak256(encodeAbiParameters(
        [{ type: 'uint256[]' }, { type: 'uint64[]' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }],
        [orderIds, pays, request.minBought, bought.inner, keccak256(bought.ciphertext), rest.inner, keccak256(rest.ciphertext)],
      ));
      return { ...(await this.prepareTransfer({ ...context, caller: market, data }, amount, null, amount, market)), contract: { kind: 'sweep', sweep } };
    }, progress);
  }

  /** Read the immutable fee from our configured contract rather than trusting a UI quote. */
  private async marketFeeBps(): Promise<number> {
    if (this.connection.config.marketVersion !== 2) return 0;
    const value = await this.connection.client.readContract({ address: this.connection.config.contracts.market, abi: marketV2, functionName: 'feeBps' });
    const bps = Number(value);
    if (!Number.isInteger(bps) || bps < 0 || bps > 1000) throw new Error('Unsupported market fee');
    return bps;
  }

  /** @orig index-CVtw0LZh.js:27425 jD.prepareRelease Sign an order release with its isolated maker key. */
  async releaseOrder(
    request: { orderId: bigint; action: 0 | 1; asset: Asset; keyIndex: number; nonce: number; deadline?: bigint },
    progress: Progress = () => {},
  ): Promise<Hex | undefined> {
    return this.paymentLock(`${LEGACY_PAYMENT_LOCK_PREFIX}${this.journal.scope}`, async () => {
      const snapshot = await this.syncUnlocked();
      const duplicate = this.journal.list().find(record =>
        ['prepared', 'exported', 'unknown', 'submitted'].includes(record.status)
        && record.intent.kind === 'release' && record.intent.orderId === request.orderId.toString()
        && record.intent.nonce === request.nonce.toString());
      if (duplicate) throw new Error(`release outcome is unresolved (${duplicate.id})`);
      const release = await this.signRelease(request, zeroAddress, 0n, request.deadline ?? snapshot.head.timestamp + 3600n);
      const intent = { kind: 'release', asset: String(request.asset), orderId: request.orderId.toString(), nonce: request.nonce.toString() };
      return this.submitPrepared(intent, '/release', release, [], [], true, progress);
    });
  }

  private async syncUnlocked(onProgress?: (block: bigint, head: bigint) => void): Promise<PrivateSnapshot> {
    // Web Locks serialize tabs, but every holder must reload writes made by the previous holder.
    await this.journal.load();
    this.snapshot = await syncPrivateNotes(this.connection, this.keys, onProgress, this.checkpointStore);
    await this.journal.reconcile(this.snapshot.spent, this.snapshot.executed, this.snapshot.executedTransactions);
    await this.reconcileReleaseReceipts(this.snapshot);
    await this.reconcileVoids();
    return this.snapshot;
  }

  private available(asset: Asset, now: bigint) {
    if (!this.snapshot) throw new Error('session is not synced');
    const pending = this.journal.unresolvedNullifiers();
    return this.snapshot.unspent.filter(note => note.note.asset === asset && note.note.lockUntil <= now && !pending.has(note.nf));
  }

  private async execute(
    intent: Record<string, string>, asset: Asset,
    prepare: (context: { asset: Asset; now: bigint; fee: bigint; relayer: Address; caller: Address; data: Hex }) => Promise<Prepared>,
    progress: Progress,
  ): Promise<Hex | undefined> {
    return this.paymentLock(`${LEGACY_PAYMENT_LOCK_PREFIX}${this.journal.scope}`, async () => {
      progress('Syncing private notes');
      const snapshot = await this.syncUnlocked();
      progress('Making the zero-fee proof');
      const prepared = await prepare({ asset, now: snapshot.head.timestamp, fee: 0n, relayer: zeroAddress, caller: zeroAddress, data: zeroHash });
      const [path, body] = this.directRequest(prepared);
      return this.submitPrepared(intent, path, body, prepared.nullifiers,
        [requestDigest(this.connection, prepared.tx)], false, progress);
    });
  }

  private quoteRequest(intent: Record<string, string>, asset: Asset): Readonly<{ operation: RelayOperation; count?: number }> {
    if (intent.kind === 'mint') return { operation: 'mint', count: Number(intent.count) };
    if (intent.kind === 'sweep') return { operation: 'sweep' };
    if (asset === 1 && ['place', 'fill'].includes(intent.kind)) return { operation: 'native' };
    return { operation: asset === 0 ? 'token' : 'native' };
  }

  private async submitPrepared(
    intent: Record<string, string>, path: RelayPath,
    body: unknown, nullifiers: bigint[], expectedDigests: Hex[], requiresExternalObservation: boolean, progress: Progress,
    walletOverride?: WalletClient, assertCurrentOverride?: () => void | Promise<void>,
  ): Promise<Hex | undefined> {
    this.signal?.throwIfAborted();
    this.assertCurrent?.();
    const mode = this.submissionMode();
    const authorization = mode === 'export' ? serializeAuthorization(this.connection, path, body) : undefined;
    const wallet = mode === 'submit' ? walletOverride ?? this.getWallet() : undefined;
    if (mode === 'submit' && !wallet) throw new Error('Connect a public wallet to submit this action');
    progress('Saving recovery record');
    const record = await this.journal.add({
      intent, path, transport: 'self', body, ...(authorization ? { authorization } : {}),
      nullifiers: nullifiers.filter(value => value !== 0n).map(String), expectedDigests, requiresExternalObservation,
    });
    this.signal?.throwIfAborted();
    if (mode === 'export') {
      await this.journal.mark(record.id, 'exported');
      const exported = this.journal.get(record.id);
      try {
        await this.onAuthorization?.(authorization!, exported);
      } catch (error) {
        // Export callbacks commonly persist the packet. If persistence fails, the
        // record must not keep its inputs reserved as an exported authorization.
        // Move it back to the discardable state first, then remove it.
        try {
          await this.journal.mark(record.id, 'prepared');
          await this.journal.discardPrepared(record.id);
        } catch {
          // Preserve the original callback error. A failed rollback remains
          // visible in the journal for explicit recovery/void handling.
        }
        throw error;
      }
      return undefined;
    }
    const preferences = path === '/shield' ? {} : await this.feePreferences(this.quoteRequest(intent, Number(intent.asset) as Asset));
    let hash: Hex;
    try {
      hash = await submitWalletAction(this.connection, wallet!, path, body, {
        gasPriceWei: preferences.gasPriceWei, gasLimit: preferences.gasLimit,
        onStage: stage => progress(stage === 'wallet' ? 'Confirm the transaction in your wallet'
          : 'Validating proof and estimating network gas'),
        beforeSend: async () => {
          this.signal?.throwIfAborted();
          this.assertCurrent?.();
          await assertCurrentOverride?.();
          await this.journal.mark(record.id, 'unknown');
        },
        onRejected: async () => { await this.journal.mark(record.id, 'prepared'); },
        assertCurrent: () => { this.assertCurrent?.(); },
      });
    } catch (error) {
      if (this.journal.get(record.id).status === 'unknown') throw new UnknownSubmissionError(record.id, error);
      throw error;
    }
    await this.markSubmitted(record.id, hash);
    progress(`Submitted ${hash} · waiting for chain confirmation`);
    const confirmed = await this.waitForRecord(record.id, hash);
    if (this.journal.get(record.id).status === 'observed') progress(`Confirmed ${confirmed}`);
    return confirmed;
  }

  private async markSubmitted(id: string, hash: Hex): Promise<void> {
    try { await this.journal.mark(id, 'submitted', hash); }
    catch (error) { throw new SubmittedPendingError(hash, id, error); }
  }

  private async waitForRecord(id: string, hash: Hex): Promise<Hex> {
      if (!this.waitForObservation) return hash;
      const deadline = Date.now() + this.observationTimeoutMs;
      let lastSyncError: unknown;
      for (;;) {
        try { await this.syncUnlocked(); lastSyncError = undefined; }
        catch (error) { lastSyncError = error; }
        const current = this.journal.list().find(item => item.id === id);
        if (current?.status === 'observed') return current.txHash ?? hash;
        if (current?.status === 'conflicted') throw new Error('another transaction spent these inputs');
        if (Date.now() >= deadline) throw new SubmittedPendingError(hash, id, lastSyncError);
        await new Promise(resolve => setTimeout(resolve, this.observationIntervalMs));
      }
  }

  private async resumeUnlocked(id: string, snapshot: PrivateSnapshot, progress: Progress): Promise<Hex | undefined> {
    const record = this.journal.get(id);
    if (record.status === 'observed') return record.txHash;
    if (record.status === 'conflicted') throw new Error('another transaction used the saved inputs; it cannot be resent');
    if (record.txHash) {
      progress(`Submitted ${record.txHash} · waiting for chain confirmation`);
      const confirmed = await this.waitForRecord(id, record.txHash);
      if (this.journal.get(id).status === 'observed') progress(`Confirmed ${confirmed}`);
      return confirmed;
    }
    if (record.nullifiers.some(value => snapshot.spent.has(BigInt(value)))) throw new Error('saved request inputs are already spent');
    await this.validateSavedRequest(record, snapshot);
    if (record.status === 'exported') {
      const wallet = this.getWallet();
      if (!wallet) throw new Error('Connect a public wallet to submit this exported authorization');
      const preferences = record.path === '/shield' ? {} : await this.feePreferences(this.quoteRequest(record.intent, Number(record.intent.asset) as Asset));
      progress('Confirm the exported authorization in your wallet');
      let hash: Hex;
      try {
        hash = await submitWalletAction(this.connection, wallet, record.path, record.body, {
          gasPriceWei: preferences.gasPriceWei, gasLimit: preferences.gasLimit,
          onStage: stage => progress(stage === 'wallet' ? 'Confirm the transaction in your wallet'
            : 'Validating proof and estimating network gas'),
          beforeSend: async () => {
            this.signal?.throwIfAborted();
            this.assertCurrent?.();
            await this.journal.mark(id, 'unknown');
          },
          onRejected: async () => { await this.journal.mark(id, 'exported'); },
          assertCurrent: () => { this.assertCurrent?.(); },
        });
      } catch (error) {
        if (this.journal.get(id).status === 'unknown') throw new UnknownSubmissionError(id, error);
        throw error;
      }
      await this.markSubmitted(id, hash);
      progress(`Submitted ${hash} · waiting for chain confirmation`);
      const confirmed = await this.waitForRecord(id, hash);
      if (this.journal.get(id).status === 'observed') progress(`Confirmed ${confirmed}`);
      return confirmed;
    }
    progress('Saved request remains locked while its chain outcome is observed');
    throw new Error('This saved request cannot be automatically resent. Check wallet activity and void it only after confirming it was not submitted.');
  }

  private primaryTransaction(record: JournalRecord): PrivateTransaction | null {
    const body = record.body as any;
    if (record.path === '/bundle') return body?.fee ?? null;
    if (record.path === '/release') return null;
    return record.path === '/relay' ? body as PrivateTransaction : body?.tx ?? null;
  }

  /** @orig index-CVtw0LZh.js:27731 HD.reconcile An observed cancel is the exact conflicting spend of its original. */
  private async reconcileVoids(): Promise<void> {
    for (const cancellation of this.journal.list()) {
      const originalId = cancellation.intent.kind === 'void' ? cancellation.intent.originalId : undefined;
      if (!originalId || cancellation.status !== 'observed') continue;
      let original: JournalRecord;
      try { original = this.journal.get(originalId); } catch { continue; }
      if (['prepared', 'exported', 'unknown', 'submitted'].includes(original.status)) await this.journal.mark(originalId, 'conflicted');
    }
  }

  private transactionFrom(record: JournalRecord): PrivateTransaction[] {
    const body = record.body as any;
    if (record.path === '/relay') return [body];
    if (record.path === '/bundle') {
      const transactions: PrivateTransaction[] = [body.fee];
      if (body.action?.tx) transactions.push(body.action.tx);
      return transactions;
    }
    if (record.path === '/release') return [];
    return body?.tx ? [body.tx] : [];
  }

  private releaseFrom(record: JournalRecord): SignedRelease | null {
    const body = record.body as any;
    if (record.path === '/release') return body as SignedRelease;
    return record.path === '/bundle' && body?.action?.kind === 'release' ? body.action.release as SignedRelease : null;
  }

  /** Validate only immutable facts; recovery always reuses the saved proof and payload. */
  private async validateSavedRequest(record: JournalRecord, snapshot: PrivateSnapshot): Promise<void> {
    const release = this.releaseFrom(record);
    if (release) {
      const order = await this.connection.client.readContract({
        address: this.connection.config.contracts.market, abi: rawAbis.market, functionName: 'orders',
        args: [BigInt(release.release.orderId)], blockNumber: snapshot.head.number,
      });
      if (Number(order.releases) !== Number(record.intent.nonce)) {
        throw new Error('order release nonce changed; another signed action may have executed');
      }
    }
    for (const tx of this.transactionFrom(record)) {
      if (BigInt(tx.pub.nowTs) > snapshot.head.timestamp) throw new Error('saved proof timestamp is ahead of the chain');
      if (!await this.connection.pool.read.knownRoot([BigInt(tx.pub.root)], { blockNumber: snapshot.head.number })) {
        throw new Error('saved proof root is no longer known; void or discard it instead');
      }
    }
  }

  /** @orig index-CVtw0LZh.js:28570 EO.waitRelayed Canonical event, receipt, calldata and nonce prove this saved release executed. */
  private async reconcileReleaseReceipts(snapshot: PrivateSnapshot): Promise<void> {
    const records = this.journal.list().filter(record =>
      ['exported', 'unknown', 'submitted'].includes(record.status) && this.releaseFrom(record));
    if (!records.length) return;
    const event = rawAbis.market.find(entry => entry.type === 'event' && entry.name === 'OrderReleased')!;
    const logs = await this.connection.client.getLogs({
      address: this.connection.config.contracts.market, event,
      fromBlock: this.connection.config.deployBlock, toBlock: snapshot.head.number, strict: true,
    });
    if ((await this.connection.client.getBlock({ blockNumber: snapshot.head.number })).hash !== snapshot.head.hash) {
      throw new Error('Chain reorganized while reconciling releases; retry');
    }
    for (const record of records) {
      const release = this.releaseFrom(record);
      if (!release) continue;
      const expected = this.releaseSubmission(record, release);
      const candidates = logs.filter(log => log.args.orderId === BigInt(release.release.orderId)
        && log.args.action === release.action && log.args.fee === BigInt(release.release.fee));
      for (const candidate of candidates) {
        let receipt: Awaited<ReturnType<PoolConnection['client']['getTransactionReceipt']>>;
        try { receipt = await this.connection.client.getTransactionReceipt({ hash: candidate.transactionHash }); }
        catch (error) {
          if (/not found|could not be found|TransactionReceiptNotFound/i.test(String(error))) continue;
          throw error;
        }
        if (receipt.status !== 'success' || receipt.blockNumber !== candidate.blockNumber
          || receipt.transactionHash !== candidate.transactionHash || receipt.blockHash !== candidate.blockHash) continue;
        const transaction = await this.connection.client.getTransaction({ hash: candidate.transactionHash });
        if (transaction.blockNumber !== candidate.blockNumber || transaction.blockHash !== candidate.blockHash
          || transaction.to?.toLowerCase() !== expected.to.toLowerCase()
          || transaction.input.toLowerCase() !== expected.data.toLowerCase()) continue;
        const order = await this.connection.client.readContract({
          address: this.connection.config.contracts.market, abi: rawAbis.market, functionName: 'orders',
          args: [BigInt(release.release.orderId)], blockNumber: receipt.blockNumber,
        });
        if (Number(order.releases) > Number(record.intent.nonce)) {
          await this.journal.mark(record.id, 'observed', candidate.transactionHash);
          break;
        }
      }
    }
  }

  private releaseSubmission(record: JournalRecord, release: SignedRelease): { to: Address; data: Hex } {
    const nested = encodeFunctionData({ abi: rawAbis.market, functionName: 'release', args: this.releaseArgs(release) });
    if (record.path === '/release') return { to: this.connection.config.contracts.market, data: nested };
    const fee = (record.body as any).fee as PrivateTransaction;
    return {
      to: this.connection.config.contracts.bundle,
      data: encodeFunctionData({
        abi: rawAbis.bundle, functionName: 'relay',
        args: [...this.contractArgs(fee), this.connection.config.contracts.market, nested],
      }),
    };
  }

  /** @orig index-CVtw0LZh.js:27310 jD.openOutput Make a zero-value encrypted note whose value is supplied by the called contract. */
  private openDeposit(asset: Asset): { inner: bigint; ciphertext: Hex } {
    const note = createNote(this.address, 0n, { asset, rseed: this.rng(32) });
    const inner = noteInner(this.address.owner, note.lockUntil, deriveNoteSecrets(note.rseed).rcm);
    const context = { chainId: BigInt(this.connection.config.chain.id), pool: hexToBytes(this.connection.config.contracts.pool) };
    return { inner, ciphertext: bytesToHex(encryptOutgoingNote(note, this.address, null, this.keys.ovk, context)) };
  }

  /** @orig index-CVtw0LZh.js:27355 jD.preparePrivateMint Construct one sealed mint recipient note. */
  private sealedNote(to: PrivateAddress, asset: Asset, value: bigint): { inner: bigint; ciphertext: Hex } {
    const note = createNote(to, value, { asset, rseed: this.rng(32) });
    const rcm = deriveNoteSecrets(note.rseed).rcm;
    const inner = noteInner(to.owner, note.lockUntil, rcm);
    const commitment = noteCommitment(note, to.owner, rcm);
    const context = { chainId: BigInt(this.connection.config.chain.id), pool: hexToBytes(this.connection.config.contracts.pool) };
    return { inner, ciphertext: bytesToHex(encryptNote(note, to, commitment, context)) };
  }

  /** @orig index-CVtw0LZh.js:26789-26840 cD/fD Select the original direct relayer route and body. */
  private directRequest(prepared: Prepared): [RelayPath, unknown] {
    if (!prepared.contract) return ['/relay', prepared.tx];
    if (prepared.contract.kind === 'mint') return ['/mint', { tx: prepared.tx, mint: prepared.contract.mint }];
    if (prepared.contract.kind === 'place') return ['/order', { tx: prepared.tx, place: prepared.contract.place }];
    if (prepared.contract.kind === 'sweep') return ['/sweep', { tx: prepared.tx, sweep: prepared.contract.sweep }];
    return ['/fill', { tx: prepared.tx, fill: prepared.contract.fill }];
  }

  /** @orig index-CVtw0LZh.js:27425 jD.prepareRelease EIP-712 release signed only by the isolated maker key. */
  private async signRelease(
    request: { orderId: bigint; action: 0 | 1; asset: Asset; keyIndex: number; nonce: number },
    relayer: Address, fee: bigint, deadline: bigint,
  ): Promise<SignedRelease> {
    if (!Number.isSafeInteger(request.nonce) || request.nonce < 0 || request.nonce > 0xffff_ffff) throw new RangeError('release nonce');
    const output = this.openDeposit(request.asset);
    const release = {
      orderId: request.orderId.toString(), inner: output.inner.toString(), ciphertext: output.ciphertext,
      relayer, fee: fee.toString(), deadline: deadline.toString(),
    };
    const signature = await privateKeyToAccount(this.orderKey(request.keyIndex)).signTypedData({
      domain: this.connection.config.domains.market,
      primaryType: 'Release',
      types: { Release: [
        { name: 'action', type: 'uint8' }, { name: 'orderId', type: 'uint256' }, { name: 'inner', type: 'uint256' },
        { name: 'ciphertextHash', type: 'bytes32' }, { name: 'relayer', type: 'address' }, { name: 'fee', type: 'uint64' },
        { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint32' },
      ] },
      message: {
        action: request.action, orderId: request.orderId, inner: output.inner, ciphertextHash: keccak256(output.ciphertext),
        relayer, fee, deadline, nonce: request.nonce,
      },
    });
    return { action: request.action, release, signature };
  }

  /** @orig index-CVtw0LZh.js:26732 oD Convert a signed release to the market ABI tuple. */
  private releaseArgs(value: SignedRelease) {
    return [value.action, {
      orderId: BigInt(value.release.orderId), inner: BigInt(value.release.inner), ciphertext: value.release.ciphertext,
      relayer: value.release.relayer, fee: BigInt(value.release.fee), deadline: BigInt(value.release.deadline),
    }, value.signature] as const;
  }

  private async prepareTransfer(
    context: { asset: Asset; now: bigint; fee: bigint; relayer: Address; caller: Address; data: Hex },
    privateAmount: bigint, recipientOutput: NoteOutput | null, publicOut: bigint, publicRecipient: Address,
    selected?: ReturnType<typeof selectInputs>,
  ): Promise<Prepared> {
    if (!this.snapshot) throw new Error('session is not synced');
    const required = privateAmount + context.fee;
    const inputs = selected ?? (required === 0n
      ? []
      : selectInputs(this.snapshot, this.journal.unresolvedNullifiers(), required, context.now, context.asset));
    const change = sum(inputs) - privateAmount - context.fee;
    if (change < 0n) throw new Error('inputs do not cover amount and fee');
    const changeOutput = { to: this.address, note: createNote(this.address, change, { asset: context.asset, rseed: this.rng(32) }) };
    const outputs: [NoteOutput, NoteOutput] = recipientOutput ? [recipientOutput, changeOutput] : [changeOutput, createDummyOutput(this.rng, context.asset)];
    if ((this.rng(1)[0]! & 1) !== 0) outputs.reverse();
    const poolContext = { chainId: BigInt(this.connection.config.chain.id), pool: hexToBytes(this.connection.config.contracts.pool) };
    const ciphertexts = outputs.map(output => {
      const cm = noteCommitment(output.note, output.to.owner, deriveNoteSecrets(output.note.rseed).rcm);
      const mine = addressOwner(this.keys.spendPub, this.keys.nkc, output.to.d) === output.to.owner;
      return mine ? encryptOutgoingNote(output.note, output.to, cm, this.keys.ovk, poolContext) : encryptNote(output.note, output.to, cm, poolContext);
    }) as [Uint8Array, Uint8Array];
    const ext = {
      recipient: hexToBytes(publicRecipient), relayer: hexToBytes(context.relayer), caller: hexToBytes(context.caller),
      data: hexToBytes(context.data), ciphertexts,
    };
    const witness = buildTransferWitness({
      keys: this.keys, tree: this.snapshot.tree, asset: context.asset, publicOut, fee: context.fee,
      now: context.now, extHash: externalDataHash(poolContext, ext),
      inputs: [inputs[0] ? { note: inputs[0].note, leafIndex: inputs[0].leafIndex } : null, inputs[1] ? { note: inputs[1].note, leafIndex: inputs[1].leafIndex } : null],
      outputs, rng: this.rng,
    });
    const { proof } = await this.prover.proveTransfer(witness.inputs as Record<string, unknown>);
    const tx: PrivateTransaction = {
      proof,
      pub: {
        root: String(witness.pub.root), nullifiers: witness.pub.nullifiers.map(String) as [string, string],
        commitments: witness.pub.commitments.map(String) as [string, string], nowTs: String(witness.pub.now),
        asset: String(witness.pub.asset), publicOut: String(witness.pub.publicOut), fee: String(witness.pub.fee),
      },
      ext: {
        recipient: publicRecipient, relayer: context.relayer, caller: context.caller, data: context.data,
        ciphertexts: ciphertexts.map(value => bytesToHex(value)) as [Hex, Hex],
      },
    };
    return { tx, nullifiers: [...witness.pub.nullifiers] };
  }

  private contractArgs(tx: PrivateTransaction) {
    return [tx.proof, {
      root: BigInt(tx.pub.root), nullifiers: tx.pub.nullifiers.map(BigInt) as [bigint, bigint], commitments: tx.pub.commitments.map(BigInt) as [bigint, bigint],
      nowTs: BigInt(tx.pub.nowTs), asset: Number(tx.pub.asset), publicOut: BigInt(tx.pub.publicOut), fee: BigInt(tx.pub.fee),
    }, {
      recipient: tx.ext.recipient, relayer: tx.ext.relayer, caller: tx.ext.caller, data: tx.ext.data, ciphertexts: tx.ext.ciphertexts,
    }] as const;
  }
}

/** Compatibility alias for integrations built before the 404 rename. */
