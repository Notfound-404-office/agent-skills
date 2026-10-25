import assert from 'node:assert/strict';
import test from 'node:test';
import { abis, rawAbis } from '../../src/abi/index.ts';
import { create404Config, createLegacy404Config, nativeUnitWei, readDeployment, relayerFees, upstreamDeployment } from '../../src/config/index.ts';

const deployment = Object.fromEntries([
  '404Pool', '404Token', '404Hasher', '404Market',
  '404Mint', '404Bundle', '404TransferVerifier', '404HoldVerifier',
].map((key, index) => [key, `0x${(index + 1).toString(16).padStart(40, '0')}`]));
const input = { chainId: 97 as const, rpcUrl: 'https://rpc.example.invalid', deployment, deployBlock: 123n };

test('canonical deployment keys are strict and predecessor aliases remain readable', () => {
  const legacyNames = ['PrivatePool', 'Token', 'PoseidonHasher', 'TransferVerifier', 'HoldVerifier'];
  const legacy = Object.fromEntries(legacyNames.map((name, index) => [name, deployment[Object.keys(deployment)[index]!]!]));
  assert.deepEqual(readDeployment(legacy), readDeployment(deployment));
  assert.deepEqual(readDeployment({ ...legacy, Token: legacy.Token }), readDeployment(deployment));
  assert.deepEqual(readDeployment({ ...legacy, ...deployment }), readDeployment(deployment));
  assert.throws(() => readDeployment({ ...legacy, ...deployment, PrivatePool: deployment['404Token'] }), /conflicting deployment addresses/);
  for (const invalid of [undefined, null, '0x00', `0x${'0'.repeat(40)}`]) {
    assert.throws(() => readDeployment({ ...deployment, '404Mint': invalid }), /invalid deployment address: 404Mint/);
  }
});

test('BSC config uses deployed addresses and patched domains, not X Layer defaults', () => {
  for (const chainId of [56, 97] as const) {
    const config = createLegacy404Config({ ...input, chainId });
    assert.equal(config.chain.id, chainId);
    assert.equal(config.chain.testnet, chainId === 97);
    assert.equal(config.chain.nativeCurrency.symbol, 'BNB');
    assert.deepEqual(config.domains.pool, { name: 'BigWall', version: '2', chainId, verifyingContract: deployment['404Pool'] });
    assert.deepEqual(config.domains.market, { name: 'BigWall Market', version: '1', chainId, verifyingContract: deployment['404Market'] });
    assert.equal(config.contracts.token, deployment['404Token']);
    assert.notEqual(config.contracts.pool, upstreamDeployment.pool);
    assert.equal(config.deployBlock, 123n);
    assert.equal(config.brand.privateAddressPrefix, '404');
    assert.deepEqual(config.relayerUrls, []);
    assert.equal(config.localDevnet, false);
  }
  const renamed = createLegacy404Config({ ...input, tokenName: 'Other', tokenSymbol: 'OT' });
  assert.equal(renamed.brand.tokenName, 'Other');
  assert.equal(renamed.domains.pool.name, 'BigWall');
  assert.equal(createLegacy404Config({ ...input, chainId: 56, localDevnet: true }).localDevnet, true);
});

test('404 defaults and explicit per-contract legacy signing profiles stay independent of asset names', () => {
  const config = create404Config({ ...input, tokenName: 'Other', tokenSymbol: 'OT' });
  assert.equal(config.brand.name, '404');
  assert.equal(config.brand.tokenSymbol, 'OT');
  assert.equal(create404Config(input).brand.tokenSymbol, '404');
  assert.equal(config.domains.pool.name, '404');
  assert.equal(config.domains.market.name, '404 Market');
  const mixed = create404Config({ ...input, signingProfiles: { pool: 'bigwall-legacy', market: '404' } });
  assert.deepEqual(mixed.signingProfiles, { pool: 'legacy-v1', market: '404' });
  assert.equal(mixed.domains.pool.name, 'BigWall');
  assert.equal(mixed.brand.tokenName, '404');
  assert.equal(mixed.brand.tokenSymbol, '404');
  assert.equal(create404Config({ ...input, tokenSymbol: 'BW', signingProfiles: { pool: 'legacy-v1', market: 'legacy-v1' } }).brand.tokenSymbol, 'BW');
  assert.equal(mixed.domains.market.name, '404 Market');
  assert.equal(createLegacy404Config(input).domains.pool.name, 'BigWall');
  for (const signingProfiles of [{ pool: 'other', market: '404' }, { pool: '404' }]) {
    assert.throws(() => create404Config({ ...input, signingProfiles: signingProfiles as never }), /signing profile/);
  }
});

test('Sepolia config keeps the compatible factory and uses ETH chain metadata', () => {
  const config = createLegacy404Config({ ...input, chainId: 11155111 });
  assert.equal(config.chain.id, 11155111);
  assert.equal(config.chain.name, 'Sepolia');
  assert.deepEqual(config.chain.nativeCurrency, { name: 'Ether', symbol: 'ETH', decimals: 18 });
  assert.equal(config.chain.testnet, true);
  assert.equal(config.domains.pool.chainId, 11155111);
});

test('market v2 is explicit and uses its own event scan start', () => {
  assert.equal(createLegacy404Config(input).marketVersion, 1);
  assert.equal(createLegacy404Config(input).marketBlock, 123n);
  const config = createLegacy404Config({ ...input, marketVersion: 2, marketBlock: '456' });
  assert.equal(config.marketVersion, 2);
  assert.equal(config.marketBlock, 456n);
  assert.throws(() => createLegacy404Config({ ...input, marketVersion: 3 as 2 }), /market version/);
  assert.throws(() => createLegacy404Config({ ...input, marketBlock: '-1' }), /market block/);
});

test('NFT self-mint policy is explicit and validates its membership contract', () => {
  const nft = `0x${'b'.repeat(40)}` as const;
  assert.deepEqual(createLegacy404Config({ ...input, mintPolicy: { mode: 'nft-self', nft } }).mintPolicy, { mode: 'nft-self', nft });
  assert.throws(() => createLegacy404Config({ ...input, mintPolicy: { mode: 'nft-self', nft: '0x00' as never } }), /mint policy/);
  assert.equal(createLegacy404Config({ ...input, mintPolicy: { mode: 'nft-self', nft, submission: 'open', free: true } }).mintPolicy?.free, true);
  assert.throws(() => createLegacy404Config({ ...input, mintPolicy: { mode: 'nft-self', nft, free: 'true' as never } }), /mint policy/);
});

test('deployment and endpoint boundaries reject incomplete or invalid inputs', () => {
  for (const value of [null, [], {}, { ...deployment, Token: '0x00' }, { ...deployment, Token: `0x${'0'.repeat(40)}` }]) {
    assert.throws(() => readDeployment(value), /deployment/);
  }
  assert.throws(() => createLegacy404Config({ ...input, chainId: 196 as 97 }), /chain id/);
  assert.throws(() => createLegacy404Config({ ...input, deployBlock: -1n }), /block/);
  assert.throws(() => createLegacy404Config({ ...input, rpcUrl: 'file:///tmp/rpc' }), /HTTP/);
  assert.throws(() => createLegacy404Config({ ...input, relayerUrls: ['https://user:secret@example.invalid'] }), /credentials/);
});

test('fixed fees match original LT and preserve native note-unit scaling', () => {
  // Pure original copied from index-CVtw0LZh.js:22162–22165; no bundle execution.
  const PT = 10n, FT = 10000n;
  const IT = (e: number) => PT * 10n ** BigInt(e);
  const LT = (e: number) => [IT(e), FT];
  for (const decimals of [0, 8, 18]) assert.deepEqual(relayerFees(decimals), LT(decimals));
  assert.equal(relayerFees(8)[0], 1_000_000_000n); // 10 token units at 8 decimals.
  assert.equal(relayerFees(8)[1] * nativeUnitWei, 100_000_000_000_000n); // 0.0001 BNB.
  assert.throws(() => relayerFees(-1), /decimals/);
});

test('ABI wrappers preserve the original bubbled-error order', () => {
  const verifierErrors = rawAbis.transferVerifier.filter(entry => entry.type === 'error');
  const poolErrors = rawAbis.pool.filter(entry => entry.type === 'error');
  assert.deepEqual(abis.pool, [...rawAbis.pool, ...verifierErrors]);
  assert.deepEqual(abis.market, [...rawAbis.market, ...poolErrors, ...verifierErrors]);
  assert.ok(rawAbis.pool.some(entry => entry.type === 'function' && entry.name === 'transact'));
});
