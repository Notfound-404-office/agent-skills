import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToHex, zeroHash, type Address, type Hex, type WalletClient } from 'viem';
import type { PoolConnection } from '../../src/chain/client.ts';
import {
  createNote, deriveAddress, deriveBytes, deriveKeys, deriveNoteSecrets, encryptOutgoingNote,
  IncrementalMerkleTree, noteCommitment,
} from '../../src/crypto/index.ts';
import { Protocol404Session } from '../../src/flows/index.ts';
import type { JournalStore } from '../../src/flows/journal.ts';

class MemoryStore implements JournalStore {
  values: unknown[] = [];
  async readAll() { return this.values; }
  async put(record: unknown) {
    const id = (record as { id: string }).id;
    this.values = [...this.values.filter(value => (value as { id: string }).id !== id), record];
  }
  async remove(id: string) { this.values = this.values.filter(value => (value as { id: string }).id !== id); }
}

const addresses = {
  pool: '0x2222222222222222222222222222222222222222', token: '0x3333333333333333333333333333333333333333',
  hasher: '0x4444444444444444444444444444444444444444',
  market: '0x6666666666666666666666666666666666666666', mint: '0x7777777777777777777777777777777777777777',
  bundle: '0x8888888888888888888888888888888888888888', transferVerifier: '0x9999999999999999999999999999999999999999',
  holdVerifier: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function fixture(empty = false) {
  const keys = deriveKeys(new Uint8Array(32));
  const address = deriveAddress(keys, deriveBytes(keys.seed, 'pm/address/0', 11));
  const tree = new IncrementalMerkleTree();
  const context = { chainId: 56n, pool: Uint8Array.from({ length: 20 }, () => 0x22) };
  const notes = [
    createNote(address, 100n, { asset: 0, rseed: new Uint8Array(32).fill(1) }),
    createNote(address, 20_000n, { asset: 1, rseed: new Uint8Array(32).fill(2) }),
  ];
  const logs = (empty ? [] : notes).map((note, index) => {
    const cm = noteCommitment(note, address.owner, deriveNoteSecrets(note.rseed).rcm);
    tree.setLeaf(index, cm);
    return {
      blockNumber: 10n, logIndex: index, eventName: 'NoteAdded',
      args: { leafIndex: BigInt(index), commitment: cm, ciphertext: bytesToHex(encryptOutgoingNote(note, address, cm, keys.ovk, context)) },
    };
  });
  const block = { number: 10n, hash: `0x${'01'.repeat(32)}` as Hex, timestamp: 100n };
  const client = {
    getBlock: async () => block,
    getLogs: async ({ address: requested }: { address: Hex }) => requested.toLowerCase() === addresses.pool ? logs : [],
    readContract: async () => 500,
    call: async () => ({ data: '0x' }), estimateGas: async () => 100n,
  };
  const pool = { read: {
    currentRoot: async () => tree.root(), nullifierCount: async () => 0n,
    nullifierDigest: async () => zeroHash, transactionDigest: async () => zeroHash, knownRoot: async () => true,
  } };
  const config = {
    chain: { id: 56, rpcUrls: { default: { http: ['http://unused'] } } }, contracts: addresses,
    deployBlock: 1n, marketVersion: 1 as const, relayerUrls: [], tokenDecimals: 8, fees: [0n, 0n],
    domains: {
      pool: { name: '404', version: '2', chainId: 56, verifyingContract: addresses.pool },
      market: { name: '404 Market', version: '1', chainId: 56, verifyingContract: addresses.market },
    },
  };
  return { keys, address, connection: { client, pool, config } as unknown as PoolConnection };
}

const proof = `0x${'12'.repeat(8000)}` as Hex;
const sessionOptions = (store: JournalStore, extra: object = {}) => ({
  journalStore: store, lock: async <T>(_name: string, operation: () => Promise<T>) => operation(),
  rng: (length: number) => new Uint8Array(length).fill(7), ...extra,
});

test('wallet-less export saves a zero-fee direct authorization before displaying it', async () => {
  const { keys, address, connection } = fixture();
  let displayed = false;
  const session = new Protocol404Session(connection, keys, { proveTransfer: async () => ({ proof }) }, sessionOptions(new MemoryStore(), {
    submissionMode: () => 'export',
    onAuthorization: (text: string, record: { status: string; authorization?: string }) => {
      assert.equal(record.status, 'exported');
      assert.equal(record.authorization, text);
      assert.ok(text.length > 20);
      displayed = true;
    },
  }));
  assert.equal(await session.send({ to: address, amount: 40n }), undefined);
  const record = session.pendingTransactions()[0]!;
  assert.equal(displayed, true);
  assert.equal(record.status, 'exported');
  assert.equal(record.path, '/relay');
  assert.equal(record.transport, 'self');
  assert.equal((record.body as any).pub.fee, '0');
  assert.equal((record.body as any).ext.relayer, '0x0000000000000000000000000000000000000000');
  await assert.rejects(session.discardPrepared(record.id), /only a request that was never broadcast/);
});

test('failed export callback releases the prepared journal record', async () => {
  const { keys, address, connection } = fixture();
  const store = new MemoryStore();
  const session = new Protocol404Session(connection, keys, { proveTransfer: async () => ({ proof }) }, sessionOptions(store, {
    submissionMode: () => 'export',
    onAuthorization: async () => { throw new Error('packet output is not writable'); },
  }));
  await assert.rejects(session.send({ to: address, amount: 40n }), /packet output is not writable/);
  assert.deepEqual(session.pendingTransactions(), []);
  assert.deepEqual(store.values, []);
});

test('bound NFT Mint rejects export while open Mint exports for a later submitting wallet', async () => {
  for (const submission of ['bound', 'open'] as const) {
    const { keys, connection } = fixture();
    (connection.config as any).mintPolicy = { mode: 'nft-self', nft: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', submission };
    let proofs = 0;
    const session = new Protocol404Session(connection, keys, {
      proveTransfer: async () => { proofs++; return { proof }; },
    }, sessionOptions(new MemoryStore(), { submissionMode: () => 'export' }));
    const mint = session.privateMint({ count: 1, lot: 1000n, priceWei: 10_000_000_000n });
    if (submission === 'bound') {
      await assert.rejects(mint, /bound to its submitting wallet/);
      assert.equal(proofs, 0);
    } else {
      assert.equal(await mint, undefined);
      const record = session.pendingTransactions()[0]!;
      assert.equal(record.status, 'exported');
      assert.equal(record.path, '/mint');
      assert.equal((record.body as any).tx.pub.fee, '0');
      assert.equal((record.body as any).tx.ext.relayer, '0x0000000000000000000000000000000000000000');
    }
  }
});

test('free open Mint builds zero-input authorization from an empty private wallet', async () => {
  const { keys, connection } = fixture(true);
  (connection.config as any).mintPolicy = {
    mode: 'nft-self', nft: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', submission: 'open',
  };
  let witnessed: Record<string, unknown> | undefined;
  let randomByte = 1;
  const session = new Protocol404Session(connection, keys, {
    proveTransfer: async inputs => { witnessed = inputs; return { proof }; },
  }, sessionOptions(new MemoryStore(), {
    submissionMode: () => 'export', rng: (length: number) => new Uint8Array(length).fill(randomByte++),
  }));

  assert.equal(await session.privateMint({ count: 1, lot: 1000n, priceWei: 0n }), undefined);
  const record = session.pendingTransactions()[0]!;
  const tx = (record.body as any).tx;
  assert.equal(record.status, 'exported');
  assert.equal(tx.pub.publicOut, '0');
  assert.equal(tx.pub.fee, '0');
  assert.equal((witnessed as any).in_value[0], '0');
  assert.equal((witnessed as any).in_value[1], '0');
  assert.equal(record.nullifiers.length, 2);
  assert.notEqual(tx.pub.nullifiers[0], tx.pub.nullifiers[1]);
});

test('token private action uses one proof and the connected wallet directly', async () => {
  const { keys, address, connection } = fixture();
  const account = '0x1212121212121212121212121212121212121212' as Address;
  let proofs = 0, sent: any;
  const progress: string[] = [];
  const wallet = {
    account: { address: account }, getAddresses: async () => [account], getChainId: async () => 56,
    sendTransaction: async (request: unknown) => { sent = request; return `0x${'ab'.repeat(32)}` as Hex; },
  } as unknown as WalletClient;
  const session = new Protocol404Session(connection, keys, {
    proveTransfer: async () => { proofs++; return { proof: '0x12' }; },
  }, sessionOptions(new MemoryStore(), {
    waitForObservation: false, getWallet: () => wallet, feePreferences: () => ({ gasPriceWei: 50_000_000n }),
    fetcher: async () => { throw new Error('must not contact relayer'); },
  }));
  assert.equal(await session.send({ to: address, amount: 40n }, message => progress.push(message)), `0x${'ab'.repeat(32)}`);
  assert.equal(proofs, 1);
  assert.equal(sent.to, addresses.pool);
  assert.equal(sent.gasPrice, 50_000_000n);
  const record = session.pendingTransactions()[0]!;
  assert.equal(record.path, '/relay');
  assert.equal(record.status, 'submitted');
  assert.equal((record.body as any).pub.fee, '0');
  assert.deepEqual(progress.slice(-4), [
    'Saving recovery record', 'Validating proof and estimating network gas', 'Confirm the transaction in your wallet',
    `Submitted 0x${'ab'.repeat(32)} · waiting for chain confirmation`,
  ]);
  assert.equal(progress.some(message => message.startsWith('Confirmed ')), false);
});

test('explicit wallet rejection restores direct records to prepared and exported records to exported', async () => {
  for (const exported of [false, true]) {
    const { keys, address, connection } = fixture();
    const account = '0x1212121212121212121212121212121212121212' as Address;
    const rejection = Object.assign(new Error('User rejected'), { code: 4001 });
    const wallet = {
      account: { address: account }, getAddresses: async () => [account], getChainId: async () => 56,
      sendTransaction: async () => { throw rejection; },
    } as unknown as WalletClient;
    let mode: 'submit' | 'export' = exported ? 'export' : 'submit';
    const session = new Protocol404Session(connection, keys, { proveTransfer: async () => ({ proof }) }, sessionOptions(new MemoryStore(), {
      submissionMode: () => mode, getWallet: () => wallet, feePreferences: () => ({ gasPriceWei: 50_000_000n }),
    }));
    if (exported) {
      await session.send({ to: address, amount: 40n });
      const id = session.pendingTransactions()[0]!.id;
      mode = 'submit';
      await assert.rejects(session.resume(id), error => error === rejection);
      assert.equal(session.pendingTransactions()[0]!.status, 'exported');
      await assert.rejects(session.discardPrepared(id), /only a request that was never broadcast/);
    } else {
      await assert.rejects(session.send({ to: address, amount: 40n }), error => error === rejection);
      const record = session.pendingTransactions()[0]!;
      assert.equal(record.status, 'prepared');
      await session.discardPrepared(record.id);
      assert.equal(session.pendingTransactions().length, 0);
    }
  }
});

test('release is a direct zero-fee zero-relayer authorization', async () => {
  const { keys, connection } = fixture();
  const session = new Protocol404Session(connection, keys, { proveTransfer: async () => ({ proof }) }, sessionOptions(new MemoryStore(), {
    submissionMode: () => 'export',
  }));
  await session.releaseOrder({ orderId: 9n, action: 1, asset: 0, keyIndex: 0, nonce: 3, deadline: 999n });
  const record = session.pendingTransactions()[0]!;
  assert.equal(record.path, '/release');
  assert.equal((record.body as any).release.fee, '0');
  assert.equal((record.body as any).release.relayer, '0x0000000000000000000000000000000000000000');
});

test('void replaces an exported action with one direct zero-fee conflict spend', async () => {
  const { keys, address, connection } = fixture();
  let proofs = 0;
  const session = new Protocol404Session(connection, keys, {
    proveTransfer: async () => { proofs++; return { proof }; },
  }, sessionOptions(new MemoryStore(), { submissionMode: () => 'export' }));
  await session.send({ to: address, amount: 40n });
  const original = session.pendingTransactions()[0]!;
  await session.void(original.id);
  const cancellation = session.pendingTransactions().find(record => record.intent.kind === 'void')!;
  assert.equal(proofs, 2);
  assert.equal(cancellation.path, '/relay');
  assert.equal(cancellation.status, 'exported');
  assert.equal((cancellation.body as any).pub.fee, '0');
  assert.equal((cancellation.body as any).ext.relayer, '0x0000000000000000000000000000000000000000');
});

test('unknown historical relayer records stay locked and are never posted again', async () => {
  const { keys, address, connection } = fixture();
  let fetches = 0;
  const session = new Protocol404Session(connection, keys, { proveTransfer: async () => ({ proof }) }, sessionOptions(new MemoryStore(), {
    submissionMode: () => 'export', fetcher: async () => { fetches++; throw new Error('must not POST'); },
  }));
  await session.send({ to: address, amount: 40n });
  const exported = session.pendingTransactions()[0]!;
  const legacy = await session.journal.add({
    intent: exported.intent, path: exported.path, relayerUrl: 'https://old-relayer.invalid', body: exported.body,
    nullifiers: exported.nullifiers, expectedDigests: exported.expectedDigests,
  });
  await session.journal.mark(legacy.id, 'unknown');
  await assert.rejects(session.resume(legacy.id), /cannot be automatically resent/);
  assert.equal(fetches, 0);
  assert.ok(session.journal.unresolvedNullifiers().size > 0);
});
