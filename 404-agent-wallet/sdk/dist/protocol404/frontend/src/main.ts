import { bytesToHex, formatUnits, hexToBytes, isAddress, parseUnits, type Address, type Hex } from 'viem';
import { create404Config, nativeUnitWei, type Protocol404ConfigInput } from './config/index.ts';
import { createNote, decodePrivateAddress, deriveAddress, deriveBytes, deriveKeys, deriveNoteSecrets, encodePrivateAddress, encryptNote, noteCommitment, noteInner, type KeyMaterial, type PrivateAddress } from './crypto/index.ts';
import { createMnemonicBackup, restoreMnemonicBackup, EncryptedWalletStore, discoverInjectedProviders, connectInjectedWallet, subscribeInjectedWalletInvalidation, createLocalNodeWallet, isLocalDevelopmentConnection, readLocalNodeAccounts, type ConnectedWallet, type InjectedProviderDescriptor } from './wallet/index.ts';
import { initUI } from './ui/index.ts';
import { claimTestNft, mintNotes, openPool, readNftMintAccess, readPoolInfo, depositNote, sweepProceeds, type PoolConnection } from './chain/client.ts';
import { syncPrivateNotes } from './chain/sync.ts';
import { Protocol404Session } from './flows/index.ts';
import { maxNoteSpend, mintFunding, parseNoteAmount } from './chain/amount.ts';
import { initTradingUI, marketTransactionUrl } from './ui/trading.ts';
import type { PrivateSnapshot } from './chain/sync.ts';
import { renderAssetLabels } from './ui/branding.ts';
import { waitForConfirmation } from './ui/confirmation.ts';
import type { FeePreferences } from './relayer-client/index.ts';
import { describeAuthorization, parseAuthorization, submitAuthorization } from './flows/portable.ts';
import { initWalletHistory, type WalletHistoryController } from './ui/history.ts';

/** @orig index-CVtw0LZh.js:28838 RO Original DOM IDs are kept throughout the reconstructed app. */
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string, value: string) => { const node = element(id); if (node) node.textContent = value; };
const field = (form: HTMLFormElement, name: string) => (form.elements.namedItem(name) as HTMLInputElement).value.trim();
const passwordField = (form: HTMLFormElement, name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
const store = new EncryptedWalletStore(localStorage);
let keys: KeyMaterial | null = null;
let addresses: PrivateAddress[] = [];
let connection: PoolConnection | null = null;
let payer: ConnectedWallet | null = null;
let asset: 0 | 1 = 0;
let newSeed = crypto.getRandomValues(new Uint8Array(32));
let syncing: Promise<void> | null = null;
let booting: Promise<void> | null = null;
let session: Protocol404Session | null = null;
let walletAbort: AbortController | null = null;
let visibleSnapshot: PrivateSnapshot | null = null;
let visibleSnapshotSession: Protocol404Session | null = null;
let walletHistory: WalletHistoryController | undefined;
let mintSource: 'private' | 'public' = 'private';
let mintInfo: Awaited<ReturnType<typeof readPoolInfo>> | null = null;
let viewGeneration = 0;
let syncingGeneration: number | null = null;
let publicBalances: { token: bigint; native: bigint } | null = null;
const maximumAmounts: Record<string, bigint> = {};
let unsubscribePayer = () => {};
let payerAttempt = 0;
let injectedProviders: readonly InjectedProviderDescriptor[] = [];
let restoringPayer = false;
let connectingPayer = false;
let proverWarmupScheduled = false;
let localAccounts: readonly Address[] = [];
let localAccountsLoad = 0;
let submissionMode: 'submit' | 'export' = localStorage.getItem('protocol404.submissionMode') === 'export' ? 'export' : 'submit';
const addressCountKey = (spendPub: bigint) => `protocol404.addressCount.${spendPub}`;
const predecessorAddressCountKey = (spendPub: bigint) => `bigwall.addressCount.${spendPub}`;

function savedAddressCount(spendPub: bigint): number {
  return Number(localStorage.getItem(addressCountKey(spendPub)) ?? localStorage.getItem(predecessorAddressCountKey(spendPub)) ?? '1');
}

const nftSelfMint = () => connection?.config.mintPolicy?.mode === 'nft-self';
const openPortableMint = () => (connection?.config.mintPolicy as { submission?: 'bound' | 'open' } | undefined)?.submission === 'open';

function nativeSymbol(): string {
  return connection?.config.chain.nativeCurrency.symbol ?? 'BNB';
}

function isTreasuryPayer(candidate: Pick<ConnectedWallet, 'address'> | null, treasury: Address | undefined): boolean {
  return !!candidate && !!treasury && candidate.address.toLowerCase() === treasury.toLowerCase();
}

const ui = initUI({
  onWalletOpen: () => { if (!store.exists()) renderNewWords(); },
  onLock: lockWallet,
  onConnect: discoverPayers,
  onRouteChange: state => {
    if (state.route === 'profile') void walletHistory?.refresh().catch(() => undefined);
  },
});
ui.setWalletState({ hasVault: store.exists() });
renderNewWords();
walletHistory = initWalletHistory({
  getContext: () => keys && connection && session && visibleSnapshot && visibleSnapshotSession === session
    ? { connection, session, snapshot: visibleSnapshot } : null,
});
const trading = initTradingUI({
  getConnection: () => connection, getSession: () => session, getPayer: () => payer,
  getRelayerFee: () => 0n,
  getSpendableValues: selected => spendableNoteValues(selected),
  confirm: (title, rows, disclosure) => confirmOperation(title, rows, `Public on chain: ${disclosure.public.join(', ')}.${disclosure.hidden?.length ? ` Hidden: ${disclosure.hidden.join(', ')}.` : ''}`),
  progress: message => ui.setNetworkStatus(message, true),
  prepareSubmission: () => ensureSubmissionReady(),
  onComplete: async () => {
    await syncing?.catch(() => undefined);
    await refresh();
  },
  onSettled: () => { renderPendingTransactions(); renderAmountHints(); renderNotes(); },
});

function ensureSubmissionReady(): void {
  if (submissionMode === 'submit' && !payer) throw new Error('Connect a wallet or choose Package only');
}

/** @orig index-CVtw0LZh.js:29261 kk Never send recovery words to a server or translation service. */
function renderNewWords() {
  element<HTMLInputElement>('backed-up').checked = false;
  element('new-words').replaceChildren(...createMnemonicBackup(newSeed).split(' ').map(word => Object.assign(document.createElement('li'), { textContent: word })));
}

/** @orig index-CVtw0LZh.js:27062 jD.constructor The first private address is seed-deterministic. */
async function unlockWallet(seed: Uint8Array) {
  viewGeneration++;
  keys = deriveKeys(seed);
  const savedCount = savedAddressCount(keys.spendPub);
  const count = Number.isSafeInteger(savedCount) && savedCount >= 1 && savedCount <= 256 ? savedCount : 1;
  addresses = Array.from({ length: count }, (_, index) => deriveAddress(keys!, deriveBytes(seed, `pm/address/${index}`, 11)));
  ui.setWalletState({ hasVault: true, unlocked: true });
  for (const id of ['pw1', 'pw2', 'import-words', 'unlock-pw']) element<HTMLInputElement>(id).value = '';
  element('new-words').replaceChildren();
  newSeed.fill(0);
  renderAddresses();
  createSession();
  await refresh();
}

/** @orig index-CVtw0LZh.js:29312 Mk Clear live key/backup material and return to the original wallet gate. */
function lockWallet() {
  viewGeneration++;
  walletAbort?.abort(new Error('Wallet locked'));
  walletAbort = null;
  keys?.seed.fill(0);
  keys?.ovk.fill(0);
  keys = null;
  session = null;
  visibleSnapshot = null;
  visibleSnapshotSession = null;
  walletHistory?.clear();
  addresses = [];
  store.lock();
  element('backup-words').replaceChildren();
  element('backup-words').hidden = true;
  for (const id of ['address', 'mint-address', 'addr-list', 'receive-addr-list', 'notes', 'pending-list']) element(id).replaceChildren();
  for (const id of ['bal-spendable', 'bal-native', 'bar-available', 'bar-native', 'bal-notes', 'bal-pending', 'bal-locked']) text(id, '—');
  element('locked-line').hidden = true;
  element('pending-card').hidden = true;
  element('mint-transaction').hidden = true;
  element('mint-transaction').replaceChildren();
  renderAmountHints();
  ui.setWalletState({ unlocked: false, hasVault: store.exists() });
}

/** @orig index-CVtw0LZh.js:29265 jk / :29304 Nk Encrypt and unlock through the original onboarding forms. */
function bindForm(selector: string, action: (form: HTMLFormElement) => Promise<void>) {
  const form = document.querySelector<HTMLFormElement>(selector)!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const buttons = [...form.querySelectorAll<HTMLButtonElement>('button[type=submit], button:not([type])')];
    if (buttons.some(button => button.disabled)) return;
    const error = form.querySelector<HTMLElement>('.error');
    if (error) error.textContent = '';
    for (const button of buttons) button.disabled = true;
    void action(form).catch(reason => {
      if (error) error.textContent = reason instanceof Error ? reason.message : String(reason);
      else ui.showError(String(reason));
    }).finally(() => { for (const button of buttons) button.disabled = false; renderAmountHints(); renderPendingTransactions(); renderNotes(); });
  });
}

/** @orig index-CVtw0LZh.js:30277 fj Keep the original explicit review step before any payment. */
function confirmOperation(title: string, rows: readonly (readonly [string, string])[], disclosure = ''): Promise<boolean> {
  const dialog = element<HTMLDialogElement>('confirm-dialog');
  if (dialog.open) return Promise.reject(new Error('Finish the current transaction review first'));
  const generation = viewGeneration;
  text('confirm-title', title); text('confirm-kicker', 'Review transaction');
  element('confirm-rows').replaceChildren(...rows.flatMap(([label, value]) => [Object.assign(document.createElement('dt'), { textContent: label }), Object.assign(document.createElement('dd'), { textContent: value })]));
  text('confirm-disclose', disclosure); element('confirm-disclose').hidden = !disclosure; element('confirm-points').replaceChildren();
  element<HTMLButtonElement>('confirm-ok').value = 'confirm';
  return waitForConfirmation(dialog, () => ui.openDialog('confirm-dialog'), () => generation === viewGeneration);
}

bindForm('#onboard-form', async form => {
  if (store.exists()) throw new Error('A wallet is already stored on this device. Unlock it first.');
  const password = passwordField(form, 'pw1');
  if (password.length < 8) throw new Error('The password needs at least 8 characters');
  if (password !== passwordField(form, 'pw2')) throw new Error('The passwords do not match');
  const creating = document.querySelector('#onboard-tabs button.active')?.getAttribute('data-tab') === 'create';
  if (creating && !element<HTMLInputElement>('backed-up').checked) throw new Error('Write down the recovery words and tick the box first');
  const seed = creating ? newSeed.slice() : restoreMnemonicBackup(element<HTMLTextAreaElement>('import-words').value);
  await store.save(seed, password);
  await unlockWallet(seed);
});
bindForm('#unlock-form', async form => unlockWallet(await store.unlock(passwordField(form, 'unlock-pw'))));

/** @orig index-CVtw0LZh.js:28130 DO Lazy proving keeps wallet creation usable before loading the WASM backend. */
function createSession() {
  visibleSnapshotSession = null;
  walletHistory?.clear();
  if (!connection || !keys) return;
  walletAbort?.abort(new Error('Wallet session replaced'));
  walletAbort = new AbortController();
  const unlockedKeys = keys;
  const activeConnection = connection, generation = viewGeneration;
  let createdSession: Protocol404Session;
  createdSession = new Protocol404Session(connection, keys, {
    async proveTransfer(inputs) {
      text('prover-status', 'Loading prover…');
      const { getProver } = await import('./prover/index.ts');
      const prover = await getProver();
      text('prover-status', 'Proving…');
      const proof = await prover.proveTransfer(inputs);
      if (keys !== unlockedKeys) throw new Error('Wallet was locked while proving. Nothing was submitted.');
      text('prover-status', 'Ready');
      return proof;
    },
  }, {
    signal: walletAbort.signal,
    feePreferences: readFeePreferences,
    getWallet: () => payer?.client,
    submissionMode: () => submissionMode,
    assertCurrent: () => {
      if (generation !== viewGeneration || keys !== unlockedKeys || connection !== activeConnection || session !== createdSession) {
        throw new Error('Wallet or network changed while preparing the action');
      }
    },
    onAuthorization: (authorization, record) => showAuthorization(authorization, record.id),
  });
  session = createdSession;
  scheduleProverWarmup();
}

function scheduleProverWarmup(): void {
  if (proverWarmupScheduled) return;
  proverWarmupScheduled = true;
  const warm = () => {
    if (!keys || !connection) { proverWarmupScheduled = false; return; }
    text('prover-status', 'Preloading prover…');
    void import('./prover/index.ts').then(module => module.prewarmProver()).then(() => {
      if (element('prover-status').textContent === 'Preloading prover…') text('prover-status', 'Ready (preloaded)');
    }).catch(() => {
      proverWarmupScheduled = false;
      if (element('prover-status').textContent === 'Preloading prover…') text('prover-status', 'Loads on first proof');
    });
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 1500 });
  else setTimeout(warm, 0);
}

function readFeePreferences(): FeePreferences {
  const gasPrice = element<HTMLInputElement>('fee-gwei').value.trim();
  const gasLimit = element<HTMLInputElement>('fee-gas-limit').value.trim();
  text('fee-settings-error', '');
  try {
    if (gasPrice && !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(gasPrice)) throw new Error('Gas price needs up to 9 decimal places');
    if (gasLimit && !/^[1-9][0-9]*$/.test(gasLimit)) throw new Error('Gas budget must be a positive whole number');
    const gasPriceWei = gasPrice ? parseUnits(gasPrice, 9) : undefined;
    const parsedLimit = gasLimit ? BigInt(gasLimit) : undefined;
    if (gasPriceWei !== undefined && gasPriceWei <= 0n) throw new Error('Gas price must be greater than zero');
    if (parsedLimit !== undefined && parsedLimit > 30_000_000n) throw new Error('Gas budget cannot exceed 30,000,000');
    return { gasPriceWei, gasLimit: parsedLimit };
  } catch (error) {
    text('fee-settings-error', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

element('fee-reset').addEventListener('click', () => {
  element<HTMLInputElement>('fee-gwei').value = '';
  element<HTMLInputElement>('fee-gas-limit').value = '';
  text('fee-settings-error', '');
  renderAmountHints();
});
for (const id of ['fee-gwei', 'fee-gas-limit']) element<HTMLInputElement>(id).addEventListener('input', () => {
  try { readFeePreferences(); } catch { /* Inline error already explains the invalid value. */ }
});

function renderSubmissionMode(): void {
  for (const button of element('submission-mode').querySelectorAll<HTMLButtonElement>('button[data-submission]')) {
    const active = button.dataset.submission === submissionMode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  }
  element('portable-mint-warning').hidden = !nftSelfMint() || openPortableMint() || submissionMode !== 'export';
  if (nftSelfMint() && !payer) text('nft-mint-status', submissionMode === 'export' && openPortableMint()
    ? 'NFT checked on submission.'
    : 'Connect wallet to check NFT access.');
  for (const form of document.querySelectorAll<HTMLFormElement>('form[data-pane="send"], form[data-pane="withdraw"], form[data-pane="consolidate"]')) {
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
    if (button) button.textContent = submissionMode === 'export' ? 'Generate authorization package' : `Prove and ${form.dataset.pane}`;
  }
  renderMintQuote(); renderAmountHints(); trading.renderBalances();
}
element('submission-mode').addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-submission]');
  if (!button) return;
  if (button.dataset.submission === submissionMode) return;
  submissionMode = button.dataset.submission === 'export' ? 'export' : 'submit';
  localStorage.setItem('protocol404.submissionMode', submissionMode);
  viewGeneration++;
  createSession();
  renderSubmissionMode();
});
renderSubmissionMode();

/** @orig index-CVtw0LZh.js:29125 dk Render and retain only public diversifiers for generated addresses. */
function renderAddresses() {
  if (!keys || !addresses.length) return;
  const latest = encodePrivateAddress(addresses.at(-1)!);
  text('address', latest);
  text('mint-address', latest);
  text('addr-count', String(addresses.length));
  for (const id of ['addr-list', 'receive-addr-list']) {
    element(id).replaceChildren(...addresses.map((address, index) => {
      const encoded = encodePrivateAddress(address);
      const code = Object.assign(document.createElement('code'), { className: 'addr-short', title: encoded, textContent: `${encoded.slice(0, 11)}…${encoded.slice(-8)}` });
      const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'small ghost', textContent: 'Copy' });
      copy.addEventListener('click', () => void navigator.clipboard.writeText(encoded).catch(reason => ui.showError(String(reason))));
      const item = document.createElement('li'); item.append(Object.assign(document.createElement('span'), { className: 'addr-index', textContent: `#${index}` }), code, copy); return item;
    }));
  }
}
for (const id of ['new-address', 'pf-new-address']) element(id).addEventListener('click', () => {
  if (!keys) return;
  addresses.push(deriveAddress(keys, deriveBytes(keys.seed, `pm/address/${addresses.length}`, 11)));
  localStorage.setItem(addressCountKey(keys.spendPub), String(addresses.length));
  renderAddresses();
});
element('show-words').addEventListener('click', () => {
  if (!keys) return;
  // Explicit reveal action only; never write the words into persistent storage.
  element('backup-words').replaceChildren(...createMnemonicBackup(keys.seed).split(' ').map(word => Object.assign(document.createElement('li'), { textContent: word })));
  element('backup-words').hidden = !element('backup-words').hidden;
});
for (const id of ['forget', 'delete-wallet']) element(id).addEventListener('click', () => {
  if (!window.confirm('Delete the encrypted wallet from this device? You need your 24 recovery words to restore it.')) return;
  lockWallet(); store.remove(); newSeed = crypto.getRandomValues(new Uint8Array(32)); renderNewWords(); ui.setWalletState({ hasVault: false });
});
for (const button of document.querySelectorAll<HTMLElement>('[data-copy]')) button.addEventListener('click', () => {
  const value = element(button.dataset.copy!).textContent ?? '';
  void navigator.clipboard.writeText(value).catch(reason => ui.showError(String(reason)));
});

type AuthorizationDescription = Awaited<ReturnType<typeof describeAuthorization>>;
type AuthorizationState = { status: 'unknown' | 'submitted'; hash?: Hex };
let inspectedAuthorization: { text: string; description: AuthorizationDescription } | null = null;

function showAuthorization(authorization: string, id?: string): void {
  element<HTMLTextAreaElement>('authorization-export').value = authorization;
  text('authorization-export-title', id ? `Authorization package · ${id}` : 'Authorization package ready');
  ui.openDialog('authorization-export-dialog');
  renderPendingTransactions();
}

function authorizationStateKey(id: string): string {
  if (!connection) throw new Error('Network configuration is not ready');
  return `protocol404.authorization.${connection.config.chain.id}.${connection.config.contracts.pool.toLowerCase()}.${id}`;
}

function readAuthorizationState(id: string): AuthorizationState | null {
  const value = localStorage.getItem(authorizationStateKey(id));
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as AuthorizationState;
    if (parsed?.status === 'unknown' && parsed.hash === undefined) return parsed;
    if (parsed?.status === 'submitted' && /^0x[0-9a-f]{64}$/i.test(parsed.hash ?? '')) return parsed;
  } catch { /* Fail closed below. */ }
  throw new Error('Saved authorization submission state is damaged; refusing to submit');
}

function writeAuthorizationState(id: string, state: AuthorizationState): void {
  localStorage.setItem(authorizationStateKey(id), JSON.stringify(state));
}

function authorizationRows(description: AuthorizationDescription): readonly (readonly [string, string])[] {
  const assetSymbol = description.asset === '1' ? nativeSymbol() : connection?.config.brand.tokenSymbol ?? '404';
  const publicOut = description.publicOut === undefined ? undefined : `${formatUnits(BigInt(description.publicOut), 8)} ${assetSymbol}`;
  return [
    ['Package', description.id],
    ['Chain', String(description.chainId)],
    ['Pool', description.pool],
    ['Contract', description.target],
    ['Operation', description.operation],
    ...(description.asset !== undefined ? [['Asset', assetSymbol] as const] : []),
    ...(publicOut !== undefined ? [['Public output', publicOut] as const] : []),
    ...(description.recipient ? [['Public recipient', description.recipient] as const] : []),
    ...(description.deadline ? [['Deadline', description.deadline] as const] : []),
    ['Transaction value', '0'],
  ];
}

async function inspectAuthorization(): Promise<void> {
  inspectedAuthorization = null;
  element<HTMLButtonElement>('authorization-submit').disabled = true;
  const activeConnection = connection;
  if (!activeConnection) throw new Error('Network configuration is not ready');
  const authorization = element<HTMLTextAreaElement>('authorization-input').value.trim();
  parseAuthorization(activeConnection, authorization);
  const description = describeAuthorization(activeConnection, authorization);
  const state = readAuthorizationState(description.id);
  inspectedAuthorization = { text: authorization, description };
  const review = element<HTMLDListElement>('authorization-review');
  review.replaceChildren(...authorizationRows(description).flatMap(([label, value]) => [
    Object.assign(document.createElement('dt'), { textContent: label }),
    Object.assign(document.createElement('dd'), { textContent: value }),
  ]));
  review.hidden = false;
  element('authorization-warning').hidden = false;
  if (state?.status === 'unknown') text('authorization-status', 'Submission outcome is unknown. Check the wallet activity; this site will not send it again automatically.');
  else if (state?.hash) {
    try {
      const receipt = await activeConnection.client.getTransactionReceipt({ hash: state.hash });
      text('authorization-status', `${receipt.status === 'success' ? 'Confirmed' : 'Reverted'} · ${state.hash}`);
    } catch { text('authorization-status', `Submitted · ${state.hash}. Waiting for a receipt.`); }
  } else text('authorization-status', 'Package validated against the current chain and contracts. Public outputs are shown above; private outputs remain unreadable.');
  element<HTMLButtonElement>('authorization-submit').disabled = !!state || !payer;
  element('authorization-needs-payer').hidden = !!payer;
  text('authorization-error', '');
}

async function submitInspectedAuthorization(): Promise<void> {
  const inspected = inspectedAuthorization, activeConnection = connection, activePayer = payer, generation = viewGeneration;
  if (!inspected || !activeConnection) throw new Error('Inspect the authorization package first');
  if (!activePayer) throw new Error('Connect a submitting wallet');
  const { id } = inspected.description;
  if (!navigator.locks) throw new Error('This browser does not support the lock required for safe submission');
  await navigator.locks.request(`protocol404:authorization:${activeConnection.config.chain.id}:${id}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('This authorization package is already being submitted in another tab');
    if (readAuthorizationState(id)) throw new Error('This package was already submitted or has an unknown outcome');
    if (!await confirmOperation('Submit authorization package', [
      ['Wallet', activePayer.address],
      ...authorizationRows(inspected.description),
    ], 'Public recipients and amounts are shown above; private outputs remain unreadable.')) return;
    const assertCurrent = () => {
      if (generation !== viewGeneration || connection !== activeConnection || payer !== activePayer) throw new Error('Wallet or network changed; review again');
    };
    const preferences = readFeePreferences();
    const hash = await submitAuthorization(activeConnection, activePayer.client, inspected.text, {
      gasPriceWei: preferences.gasPriceWei,
      gasLimit: preferences.gasLimit,
      assertCurrent,
      beforeSend: async () => { assertCurrent(); writeAuthorizationState(id, { status: 'unknown' }); },
      onRejected: async () => {
        localStorage.removeItem(authorizationStateKey(id));
        inspectedAuthorization = null;
        element<HTMLButtonElement>('authorization-submit').disabled = true;
        text('authorization-status', 'Wallet rejected the request. Inspect the package again to retry.');
      },
    });
    writeAuthorizationState(id, { status: 'submitted', hash });
    text('authorization-status', `Submitted · ${hash}`);
    element<HTMLButtonElement>('authorization-submit').disabled = true;
  });
}

element('authorization-open').addEventListener('click', () => {
  inspectedAuthorization = null;
  element<HTMLDListElement>('authorization-review').hidden = true;
  element('authorization-warning').hidden = true;
  text('authorization-status', ''); text('authorization-error', '');
  element<HTMLButtonElement>('authorization-submit').disabled = true;
  element('authorization-needs-payer').hidden = !!payer;
  ui.openDialog('authorization-dialog');
});
element('authorization-close').addEventListener('click', () => ui.closeDialog('authorization-dialog'));
element('authorization-export-close').addEventListener('click', () => ui.closeDialog('authorization-export-dialog'));
element('authorization-copy').addEventListener('click', () => void navigator.clipboard.writeText(element<HTMLTextAreaElement>('authorization-export').value).catch(reason => ui.showError(String(reason))));
element('authorization-inspect').addEventListener('click', () => void inspectAuthorization().catch(reason => text('authorization-error', reason instanceof Error ? reason.message : String(reason))));
element('authorization-submit').addEventListener('click', () => void submitInspectedAuthorization().catch(reason => text('authorization-error', reason instanceof Error ? reason.message : String(reason))));
element<HTMLTextAreaElement>('authorization-input').addEventListener('input', () => {
  inspectedAuthorization = null; element<HTMLDListElement>('authorization-review').hidden = true;
  element('authorization-warning').hidden = true; element<HTMLButtonElement>('authorization-submit').disabled = true;
  text('authorization-status', ''); text('authorization-error', '');
});

/** @orig index-CVtw0LZh.js:22175 BT Connect via the injected provider, never a backend-held user key. */
function renderPayer() {
  document.body.classList.toggle('no-payer', !payer);
  element('payer-connect').hidden = !!payer;
  element('payer-info').hidden = !payer;
  element('pf-payer').hidden = !payer;
  text('connect', payer ? `${payer.address.slice(0, 6)}…${payer.address.slice(-4)}` : 'Connect wallet');
  for (const id of ['payer-address', 'pf-payer-address']) text(id, payer?.address ?? '');
  text('payer-label', payer?.label ?? '');
  for (const id of ['payer-native', 'pf-payer-native']) text(id, publicBalances ? formatUnits(publicBalances.native, 18) : '—');
  for (const id of ['payer-token', 'pf-payer-token']) text(id, publicBalances ? formatUnits(publicBalances.token, 8) : '—');
  text('bar-public', publicBalances ? `${formatUnits(publicBalances.token, 8)} ${mintInfo?.symbol ?? '404'}` : '—');
  text('bar-public-native', publicBalances ? `${formatUnits(publicBalances.native, 18)} ${nativeSymbol()}` : '—');
  element('sweep-box').hidden = !isTreasuryPayer(payer, mintInfo?.treasury);
  element('authorization-needs-payer').hidden = !!payer;
  element<HTMLButtonElement>('authorization-submit').disabled = !payer || !inspectedAuthorization
    || !!(inspectedAuthorization && readAuthorizationState(inspectedAuthorization.description.id));
  renderAmountHints();
  renderMintQuote();
}
function disconnectPayer(forget = true) {
  if (forget) {
    try { localStorage.removeItem('protocol404.connectedWallet'); } catch { /* Storage may be unavailable. */ }
  }
  payerAttempt++;
  unsubscribePayer();
  unsubscribePayer = () => {};
  payer = null;
  publicBalances = null;
  viewGeneration++;
  createSession();
  renderPayer();
  void refresh().catch(reason => ui.showError(String(reason)));
}
element('disconnect').addEventListener('click', () => disconnectPayer());

function rememberedPayer(): { key: string; address: Address } | null {
  try {
    const value = JSON.parse(localStorage.getItem('protocol404.connectedWallet') ?? 'null') as { key?: unknown; address?: unknown } | null;
    if (typeof value?.key === 'string' && typeof value.address === 'string' && isAddress(value.address, { strict: false })) {
      return { key: value.key, address: value.address };
    }
  } catch { /* Missing/damaged storage does not grant wallet access. */ }
  return null;
}

function activateInjectedPayer(provider: InjectedProviderDescriptor, connected: ConnectedWallet): void {
  if (!connection) return;
  unsubscribePayer();
  payer = connected;
  publicBalances = null;
  try {
    localStorage.setItem('protocol404.connectedWallet', JSON.stringify({ key: provider.key, address: connected.address }));
  } catch { /* Connecting still works without persistence. */ }
  unsubscribePayer = subscribeInjectedWalletInvalidation(provider.provider, () => {
    disconnectPayer(false);
    setTimeout(() => void restoreAuthorizedPayer(), 500);
  }, { address: connected.address, chainId: connection.config.chain.id });
  viewGeneration++;
  createSession();
  renderPayer();
}

async function restoreAuthorizedPayer(): Promise<void> {
  const current = connection, saved = rememberedPayer();
  if (payer || connectingPayer || restoringPayer || !current || !saved) return;
  const provider = injectedProviders.find(provider => provider.key === saved.key);
  if (!provider) return;
  restoringPayer = true;
  const attempt = ++payerAttempt;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // eth_accounts only: never request permission or change the selected chain silently.
    const connected = await Promise.race([
      (async () => {
        const wallet = await connectInjectedWallet(provider, current.config.chain, true);
        if (!wallet || wallet.address.toLowerCase() !== saved.address.toLowerCase()
          || await wallet.client.getChainId() !== current.config.chain.id) return null;
        return wallet;
      })(),
      new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 8000); }),
    ]);
    if (!connected) return;
    if (attempt !== payerAttempt || current !== connection || payer) return;
    activateInjectedPayer(provider, connected);
    void refresh().catch(reason => ui.showError(String(reason)));
  } catch { /* Locked/revoked/offline wallets require no automatic prompt. */ }
  finally { clearTimeout(timeout); restoringPayer = false; }
}

window.addEventListener('focus', () => void restoreAuthorizedPayer());
window.addEventListener('online', () => void restoreAuthorizedPayer());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void restoreAuthorizedPayer();
});
element('sweep').addEventListener('click', () => {
  void (async () => {
    const activeConnection = connection, activePayer = payer;
    if (!activeConnection || !activePayer) throw new Error('Connect the treasury wallet first');
    const info = await readPoolInfo(activeConnection);
    if (connection !== activeConnection || payer !== activePayer || !isTreasuryPayer(activePayer, info.treasury)) {
      throw new Error('The connected account is not the pool treasury');
    }
    const native = activeConnection.config.chain.nativeCurrency.symbol;
    if (!await confirmOperation('Sweep mint proceeds', [
      ['Amount', `${formatUnits(info.mintProceeds, 18)} ${native}`],
      ['Treasury', info.treasury],
    ], 'Mint proceeds and the treasury address are public on chain.')) return;
    await sweepProceeds(activeConnection, activePayer.client, () => {
      if (connection !== activeConnection || payer !== activePayer) throw new Error('Wallet changed; review the sweep again');
    });
    await refresh();
  })().catch(reason => ui.showError(String(reason)));
});
function localAccountsAllowed() {
  return !!connection && isLocalDevelopmentConnection(
    connection.config.chain.id,
    connection.config.chain.rpcUrls.default.http[0]!,
    location.href,
    connection.config.localDevnet,
  );
}
async function loadLocalAccounts() {
  const load = ++localAccountsLoad, current = connection;
  localAccounts = [];
  const select = element<HTMLSelectElement>('local-account'), button = element<HTMLButtonElement>('use-local');
  select.replaceChildren(); button.disabled = true;
  element('local-accounts').hidden = !localAccountsAllowed();
  if (!current || !localAccountsAllowed()) return;
  const accounts = await readLocalNodeAccounts(
    current.config.chain,
    current.config.chain.rpcUrls.default.http[0]!,
    location.href,
    current.config.localDevnet,
  );
  if (load !== localAccountsLoad || current !== connection || !localAccountsAllowed()) return;
  localAccounts = accounts.filter(account => isAddress(account, { strict: false }));
  select.replaceChildren(...localAccounts.map((address, index) => Object.assign(document.createElement('option'), {
    value: address, textContent: `#${index} ${address}`, selected: index === 1,
  })));
  button.disabled = localAccounts.length === 0;
  if (!localAccounts.length) text('connect-error', 'No unlocked test accounts. Start the disposable Anvil devnet first.');
}
element('use-local').addEventListener('click', () => {
  void (async () => {
    const current = connection, selected = element<HTMLSelectElement>('local-account').value;
    if (!current || !localAccountsAllowed() || !localAccounts.some(account => account.toLowerCase() === selected.toLowerCase())) throw new Error('Select a local development account first');
    if (connectingPayer) return;
    connectingPayer = true;
    try {
      const attempt = ++payerAttempt;
      if (await current.client.getChainId() !== current.config.chain.id) throw new Error('The local RPC chain changed; reconnect');
      if (attempt !== payerAttempt || current !== connection || !localAccountsAllowed()) return;
      try { localStorage.removeItem('protocol404.connectedWallet'); } catch { /* No persisted local-node accounts. */ }
      unsubscribePayer(); unsubscribePayer = () => {};
      // Even on a chain-56 fork this is an unlocked disposable Anvil account,
      // never a public-mainnet wallet.
      payer = createLocalNodeWallet(selected as Address, current.config.chain, current.config.chain.rpcUrls.default.http[0]!);
      publicBalances = null;
      viewGeneration++;
      createSession();
      renderPayer(); ui.closeDialog('connect-dialog');
      await refresh();
    } finally { connectingPayer = false; }
  })().catch(reason => text('connect-error', String(reason)));
});

async function connectPayer(provider: InjectedProviderDescriptor): Promise<void> {
  const current = connection;
  if (!current) throw new Error('Configure and verify a deployment before connecting');
  if (connectingPayer) return;
  connectingPayer = true;
  try {
    const attempt = ++payerAttempt;
    const connected = await connectInjectedWallet(provider, current.config.chain);
    if (attempt !== payerAttempt || current !== connection) return;
    if (!connected) throw new Error('No account returned');
    activateInjectedPayer(provider, connected);
    ui.closeDialog('connect-dialog');
    await refresh();
  } finally { connectingPayer = false; }
}

function discoverPayers() {
  renderPayer();
  text('connect-error', '');
  void loadLocalAccounts().catch(reason => text('connect-error', String(reason)));
  renderInjectedProviders();
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
function renderInjectedProviders() {
  element('wallet-list').replaceChildren(...injectedProviders.map(provider => {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: provider.name });
    button.addEventListener('click', () => {
      void connectPayer(provider).catch(reason => text('connect-error', String(reason)));
    });
    const li = document.createElement('li'); li.append(button); return li;
  }));
  element('no-wallet').hidden = injectedProviders.length > 0 || localAccountsAllowed();
  if (!injectedProviders.length && !localAccountsAllowed()) text('connect-error', 'No browser wallet detected. Install an EIP-1193 compatible wallet.');
}

/** @orig index-CVtw0LZh.js:28203 EO.publicBalances Display only verified public/private chain values. */
async function refresh() {
  const generation = viewGeneration;
  if (syncing) {
    if (syncingGeneration === generation) return syncing;
    // The prior scan may finish, but must not swallow a newer wallet's requested refresh.
    await syncing.catch(() => undefined);
    if (generation !== viewGeneration) return;
    return refresh();
  }
  syncingGeneration = generation;
  const capturedKeys = keys, capturedSession = session, capturedPayer = payer;
  const stale = () => generation !== viewGeneration;
  syncing = (async () => {
    if (!connection) { ui.setNetworkStatus('Deployment not configured'); return; }
    const current = connection;
    ui.setNetworkStatus(`Reading ${current.config.chain.name}…`, true);
    const info = await readPoolInfo(current);
    if (stale()) return;
    const native = current.config.chain.nativeCurrency.symbol;
    renderAssetLabels(document, { tokenSymbol: info.symbol, nativeSymbol: current.config.chain.nativeCurrency.symbol });
    mintInfo = info;
    element('sweep-box').hidden = !isTreasuryPayer(capturedPayer, info.treasury);
    element('mint-source-row').hidden = !session || nftSelfMint();
    if (nftSelfMint()) mintSource = 'private';
    element('nft-mint-policy').hidden = !nftSelfMint();
    if (nftSelfMint()) {
      if (capturedPayer) {
        const access = await readNftMintAccess(current, capturedPayer.address);
        if (stale()) return;
        text('nft-mint-status', access.balance === 0n
          ? `NFT required · ${access.minted}/10 minted`
          : `${access.minted}/10 minted · ${access.remaining} remaining`);
        element('claim-test-nft').hidden = current.config.chain.id !== 11155111 || access.balance > 0n;
      } else {
        text('nft-mint-status', submissionMode === 'export' && openPortableMint()
          ? 'NFT checked on submission.'
          : 'Connect wallet to check NFT access.');
        element('claim-test-nft').hidden = true;
      }
    }
    renderMintQuote();
    text('mint-info', info.price === 0n
      ? `${formatUnits(info.lot, info.decimals)} ${info.symbol} per lot · Free`
      : `${formatUnits(info.lot, info.decimals)} ${info.symbol} per lot · ${formatUnits(info.price, 18)} ${native}`);
    text('supply-minted', formatUnits(info.mintedLots * info.lot, info.decimals));
    text('supply-total', ` / ${formatUnits(info.maxLots * info.lot, info.decimals)} ${info.symbol}`);
    const supplyBar = element<HTMLProgressElement>('supply-bar'); supplyBar.max = Number(info.maxLots); supplyBar.value = Number(info.mintedLots);
    text('supply-pct', `${Number(info.mintedLots * 10000n / info.maxLots) / 100}%`);
    text('supply-left', `${info.maxLots - info.mintedLots} lots left`);
    text('mint-proceeds', `${formatUnits(info.mintProceeds, 18)} ${native}`);
    element<HTMLInputElement>('mint-count').max = '1';
    if (capturedPayer) {
      const [nativeBalance, balance] = await Promise.all([current.client.getBalance({ address: capturedPayer.address }), current.token.read.balanceOf([capturedPayer.address])]);
      if (stale()) return;
      text('bar-public', `${formatUnits(balance, 8)} ${info.symbol}`); text('bar-public-native', `${formatUnits(nativeBalance, 18)} ${native}`);
      publicBalances = { token: balance, native: nativeBalance };
      renderPayer();
      text('pf-payer-address', capturedPayer.address); text('pf-payer-native', formatUnits(nativeBalance, 18)); text('pf-payer-token', formatUnits(balance, 8));
      element('pf-payer').hidden = false;
    }
    if (capturedKeys) {
      const scanningKeys = capturedKeys;
      const progress = (block: bigint, head: bigint) => { if (!stale()) ui.setNetworkStatus(`Syncing ${block}/${head}`, true); };
      const snapshot = capturedSession ? await capturedSession.sync(progress) : await syncPrivateNotes(current, scanningKeys, progress);
      if (stale() || keys !== scanningKeys) return;
      visibleSnapshot = snapshot;
      visibleSnapshotSession = capturedSession;
      // Recovery finds deterministic addresses already used on chain, even after losing device metadata.
      const seen = new Set(snapshot.owned.map(owned => bytesToHex(owned.note.d)));
      let used = addresses.length;
      for (let index = 1; index < 256 && seen.size; index++) if (seen.has(bytesToHex(deriveBytes(keys.seed, `pm/address/${index}`, 11)))) used = Math.max(used, index + 1);
      while (addresses.length < used) addresses.push(deriveAddress(keys, deriveBytes(keys.seed, `pm/address/${addresses.length}`, 11)));
      localStorage.setItem(addressCountKey(keys.spendPub), String(addresses.length));
      renderAddresses();
      renderMintQuote();
      const pending = session?.journal.unresolvedNullifiers() ?? new Set<bigint>();
      const spendable = (selected: 0 | 1) => snapshot.unspent.filter(owned => !pending.has(owned.nf) && owned.note.asset === selected && owned.note.lockUntil <= snapshot.head.timestamp).reduce((total, owned) => total + owned.note.value, 0n);
      text('bal-spendable', `${formatUnits(spendable(0), 8)} ${info.symbol}`); text('bar-available', `${formatUnits(spendable(0), 8)} ${info.symbol}`);
      text('bal-native', `${formatUnits(spendable(1), 8)} ${native}`); text('bar-native', `${formatUnits(spendable(1), 8)} ${native}`);
      text('bal-notes', String(snapshot.unspent.length));
      const locked = snapshot.unspent.filter(owned => owned.note.asset === 0 && owned.note.lockUntil > snapshot.head.timestamp).reduce((total, owned) => total + owned.note.value, 0n);
      text('bal-locked', `${formatUnits(locked, 8)} ${info.symbol}`); element('locked-line').hidden = locked === 0n;
      text('bal-pending', String(snapshot.unspent.filter(note => pending.has(note.nf)).length));
      renderNotes();
      renderPendingTransactions();
    }
    renderAmountHints();
    await trading.refresh();
    if (stale()) return;
    ui.setNetworkStatus('Synced');
    element('network-retry').hidden = true;
  })().catch(reason => { if (stale()) return; element('network-retry').hidden = false; ui.setNetworkStatus(`Network unavailable: ${String(reason)}`); throw reason; }).finally(() => { syncing = null; syncingGeneration = null; renderPendingTransactions(); });
  return syncing;
}

/** Show durable recovery records even when the RPC or relayer is unavailable. */
function renderPendingTransactions() {
  if (ui.getRoute().route === 'profile') void walletHistory?.refresh().catch(() => undefined);
  renderMintTransaction();
  const records = session?.pendingTransactions().filter(record => !['observed', 'conflicted'].includes(record.status)) ?? [];
  element('pending-card').hidden = records.length === 0;
  element('pending-list').replaceChildren(...records.map(record => {
    const item = Object.assign(document.createElement('li'), { textContent: `${record.intent.kind ?? 'Payment'} · ${record.status}${record.txHash ? ` · ${record.txHash}` : ''}. Do not create it again while unresolved. ` });
    const actionSession = session!;
    if (record.status === 'exported' && record.authorization) {
      const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'small', textContent: 'Copy package' });
      copy.addEventListener('click', () => showAuthorization(record.authorization!, record.id));
      item.append(copy);
    } else if (record.txHash) {
      const observe = Object.assign(document.createElement('button'), { type: 'button', className: 'small', textContent: 'Check chain' });
      observe.addEventListener('click', () => void actionSession.resume(record.id, message => ui.setNetworkStatus(message, true))
        .then(refresh).catch(reason => text('pending-error', String(reason))).finally(renderPendingTransactions));
      item.append(observe);
    }
    if (record.status === 'prepared') {
      const discard = Object.assign(document.createElement('button'), { type: 'button', className: 'small ghost', textContent: 'Discard' });
      discard.addEventListener('click', () => void actionSession.discardPrepared(record.id).then(refresh).catch(reason => text('pending-error', String(reason))).finally(renderPendingTransactions));
      item.append(discard);
    } else {
      const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'small ghost', textContent: 'Void locked notes' });
      cancel.addEventListener('click', () => {
        void (async () => {
          if (!await confirmOperation('Void the original request', [['Original request', record.id], ['Submission', submissionMode === 'export' ? 'Create a void package' : 'Submit now']], 'A replacement proof spends one original input. After it confirms on chain, the original action cannot land.')) return;
          await actionSession.void(record.id, message => ui.setNetworkStatus(message, true)); await refresh();
        })().catch(reason => text('pending-error', String(reason))).finally(renderPendingTransactions);
      });
      item.append(cancel);
    }
    return item;
  }));
}

function renderMintTransaction(): void {
  const result = element('mint-transaction');
  const record = session?.pendingTransactions().find(record => record.intent.kind === 'mint');
  result.hidden = !record?.txHash;
  result.replaceChildren();
  if (!record?.txHash || !connection) return;
  result.append(record.status === 'observed' ? 'Mint confirmed on chain. ' : 'Mint submitted · waiting for chain confirmation. ');
  const url = marketTransactionUrl(connection.config.chain.id, record.txHash);
  const link = Object.assign(document.createElement('a'), {
    textContent: record.txHash, href: url, target: '_blank', rel: 'noopener noreferrer', className: 'addr',
  });
  result.append(link);
}

/** @orig index-CVtw0LZh.js:29746 fA Max follows the two-note circuit, not the total wallet balance. */
function renderAmountHints() {
  const values = spendableNoteValues(asset);
  const privateMax = maxNoteSpend(values);
  // Original reserve: 0.001 native for public-wallet transaction gas. It is not a gas quote.
  const nativeBalance = publicBalances ? publicBalances.native / nativeUnitWei : 0n;
  const publicMax = publicBalances ? asset === 0 ? publicBalances.token : nativeBalance > 100000n ? nativeBalance - 100000n : 0n : 0n;
  const symbol = asset === 1 ? connection?.config.chain.nativeCurrency.symbol ?? 'BNB' : mintInfo?.symbol ?? connection?.config.brand.tokenSymbol ?? '404';
  const masked = (value: bigint) => Object.assign(document.createElement('span'), { className: 'maskable', textContent: `${formatUnits(value, 8)} ${symbol}` });
  for (const pane of ['send', 'withdraw', 'deposit']) {
    const hint = document.querySelector<HTMLElement>(`[data-hint="${pane}"]`)!;
    const maximum = keys ? pane === 'deposit' ? maxNoteSpend([publicMax]) : privateMax : 0n;
    maximumAmounts[pane] = maximum;
    hint.querySelector<HTMLButtonElement>('[data-max]')!.hidden = maximum === 0n;
    const description = hint.querySelector('span')!;
    description.replaceChildren();
    if (!keys) continue;
    if (pane === 'deposit') {
      description.append(...publicBalances ? ['Public wallet ', masked(asset === 0 ? publicBalances.token : nativeBalance)] : ['Connect a public wallet first']);
    } else if (visibleSnapshot) {
      description.append('Available ', masked(values.reduce((sum, value) => sum + value, 0n)), ' · up to ', masked(privateMax), ' per transaction');
    }
  }
  const count = values.length;
  text('consolidate-info', count < 2 ? `${count} ${symbol} notes: nothing to merge` : `Merges the two smallest of your ${count} ${symbol} notes into one`);
  trading.renderBalances();
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-max]')) button.addEventListener('click', () => {
  const pane = button.closest<HTMLElement>('[data-hint]')!.dataset.hint!;
  if (!['send', 'withdraw', 'deposit'].includes(pane)) return;
  renderAmountHints();
  if (!maximumAmounts[pane]) return;
  const input = document.querySelector<HTMLInputElement>(`form[data-pane="${pane}"] input[name="amount"]`)!;
  input.value = formatUnits(maximumAmounts[pane]!, 8);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
/** @orig index-CVtw0LZh.js:29600 _A Render spendable/locked/pending/spent notes without HTML interpolation. */
function renderNotes() {
  if (!visibleSnapshot || !keys) return;
  const snapshot = visibleSnapshot;
  const pending = session?.journal.unresolvedNullifiers() ?? new Set<bigint>();
  const all = document.querySelector('#notes-filter button.active')?.getAttribute('data-filter') === 'all';
  const notes = snapshot.owned.filter(owned => owned.note.value > 0n && (all || !snapshot.spent.has(owned.nf)));
  text('notes-count', String(notes.length));
  element('notes').replaceChildren(...notes.map(owned => {
    const status = snapshot.spent.has(owned.nf) ? 'Spent' : pending.has(owned.nf) ? 'In progress' : owned.note.lockUntil > snapshot.head.timestamp ? 'Locked' : 'Spendable';
    const memo = new TextDecoder().decode(owned.note.memo).replace(/\0+$/, '');
    const row = document.createElement('tr');
    row.append(...[`#${owned.leafIndex}`, `${formatUnits(owned.note.value, 8)} ${owned.note.asset === 1 ? nativeSymbol() : connection?.config.brand.tokenSymbol ?? '404'}`, status, memo].map(value => Object.assign(document.createElement('td'), { textContent: value })));
    return row;
  }));
}
for (const button of document.querySelectorAll<HTMLButtonElement>('#notes-filter button')) button.addEventListener('click', () => {
  for (const peer of document.querySelectorAll<HTMLButtonElement>('#notes-filter button')) { peer.classList.toggle('active', peer === button); peer.setAttribute('aria-pressed', String(peer === button)); }
  renderNotes();
});
for (const id of ['sync-now', 'network-retry']) element(id).addEventListener('click', () => {
  void (connection ? refresh() : bootNetwork()).catch(showNetworkError);
});

/** @orig index-CVtw0LZh.js:27261 jD.sealed Create a genuine protocol note/ciphertext for public ingress. */
function sealed(to: PrivateAddress, selected: 0 | 1, amount: bigint) {
  if (!connection || !keys) throw new Error('Unlock the wallet and configure a network first');
  const note = createNote(to, amount, { asset: selected });
  const { rcm } = deriveNoteSecrets(note.rseed);
  const commitment = noteCommitment(note, to.owner, rcm);
  return { inner: noteInner(to.owner, note.lockUntil, rcm), ciphertext: bytesToHex(encryptNote(note, to, commitment, { chainId: BigInt(connection.config.chain.id), pool: hexToBytes(connection.config.contracts.pool) })) };
}
bindForm('form[data-pane=mint]', async form => {
  const self = nftSelfMint(), source = self ? 'private' : mintSource;
  const generation = viewGeneration, activeSession = session;
  if (!connection || !keys) throw new Error('Unlock a private wallet and configure a network first');
  if (submissionMode === 'export' && self && !openPortableMint()) throw new Error('This deployed Mint binds its submitting wallet. Switch to Submit now or use the upgraded open Mint pool.');
  if ((source === 'public' || submissionMode === 'submit') && !payer) throw new Error(self ? 'Connect a public wallet holding the membership NFT' : 'Connect a public wallet');
  const activeConnection = connection, activePayer = payer;
  const native = activeConnection.config.chain.nativeCurrency.symbol;
  const assertCurrent = () => {
    if (generation !== viewGeneration || connection !== activeConnection || payer !== activePayer || session !== activeSession) {
      throw new Error('Wallet changed; review the payment again');
    }
  };
  const count = Number(field(form, 'count'));
  const info = await readPoolInfo(activeConnection);
  if (generation !== viewGeneration) return;
  if (activeConnection.config.chain.id === 11155111 && info.price !== 0n) throw new Error('Mint must be free on this deployment. Reload the current 404 site.');
  if (count !== 1) throw new Error('Each mint must be exactly one lot');
  if (info.now < info.mintStart || info.mintedLots + BigInt(count) > info.maxLots) throw new Error('Mint not open or sold out');
  const recipient = field(form, 'to') ? decodePrivateAddress(field(form, 'to')) : addresses.at(-1)!;
  if (source === 'private') {
    if (!activeSession) throw new Error('Unlock the private wallet first');
    await refresh(); // Recheck spendable inputs before proving.
    assertCurrent();
    if (self && submissionMode === 'submit') {
      const access = await readNftMintAccess(activeConnection, activePayer!.address);
      if (access.balance === 0n) throw new Error('This wallet does not hold the required membership NFT');
      if (access.minted >= 10n) throw new Error('This wallet has reached its 10-mint limit');
    }
  }
  if (source === 'private' && info.price > 0n) {
    const funding = mintFunding(spendableNoteValues(1), info.price * BigInt(count), 0n);
    if (funding.minimumTopup > 0n) throw new Error(`This pool charges ${formatUnits(info.price, 18)} ${native} per lot. Deposit at least ${formatUnits(funding.minimumTopup, 8)} ${native} into your private balance before Mint, or merge private ${native} notes first. Mint uses at most two notes.`);
  }
  const submitRows: Array<readonly [string, string]> = submissionMode === 'export'
    ? [['Submission', 'Create authorization package only']]
    : [['Wallet', activePayer?.address ?? 'Connect wallet']];
  const mintPrice = info.price === 0n ? 'Free' : `${formatUnits(info.price * BigInt(count), 18)} ${native}`;
  if (!await confirmOperation('Mint private tokens', [...(info.price === 0n ? [] : [['Pay from', source === 'private' ? `Private ${native}` : 'Public wallet'] as const]), ['Lots', String(count)], ['Mint price', mintPrice], ...submitRows, ['To', encodePrivateAddress(recipient)]])) return;
  assertCurrent();
  if (source === 'private') {
    if (!activeSession) throw new Error('Unlock the private wallet first');
    await activeSession.privateMint({ count, lot: info.lot, priceWei: info.price, to: recipient,
      ...(self && submissionMode === 'submit' ? { wallet: activePayer!.client, assertCurrent } : {}) }, message => {
        ui.setNetworkStatus(message, true);
        renderPendingTransactions();
      });
  } else {
    const notes = Array.from({ length: count }, () => sealed(recipient, 0, info.lot));
    ui.setNetworkStatus('Confirm mint in your wallet', true);
    await mintNotes(activeConnection, activePayer!.client, notes.map(note => note.inner), notes.map(note => note.ciphertext), assertCurrent);
  }
  await refresh();
});
bindForm('form[data-pane=deposit]', async form => {
  const selectedAsset = asset;
  if (!connection || !payer || !keys) throw new Error('Unlock a private wallet and connect a public wallet first');
  const generation = viewGeneration, activeConnection = connection, activePayer = payer, activeSession = session;
  const assertCurrent = () => {
    if (generation !== viewGeneration || connection !== activeConnection || payer !== activePayer || session !== activeSession) {
      throw new Error('Wallet changed; review the payment again');
    }
  };
  const amount = parseNoteAmount(field(form, 'amount'));
  if (!await confirmOperation('Deposit into the private pool', [['Amount', `${formatUnits(amount, 8)} ${selectedAsset === 1 ? activeConnection.config.chain.nativeCurrency.symbol : connection.config.brand.tokenSymbol}`]], 'Your public account and deposit amount are visible on chain.')) return;
  const note = sealed(addresses.at(-1)!, selectedAsset, amount);
  ui.setNetworkStatus('Confirm deposit in your wallet', true);
  await depositNote(activeConnection, activePayer.client, selectedAsset, amount, note.inner, note.ciphertext, assertCurrent);
  await refresh();
});
for (const button of document.querySelectorAll<HTMLButtonElement>('#asset-switch button')) button.addEventListener('click', () => {
  asset = Number(button.dataset.asset) === 1 ? 1 : 0;
  for (const peer of document.querySelectorAll<HTMLButtonElement>('#asset-switch button')) { peer.classList.toggle('active', peer === button); peer.setAttribute('aria-pressed', String(peer === button)); }
  renderAmountHints();
});
/** @orig index-CVtw0LZh.js:30383 Mint source/receipt stays in native wei for price, note units for fee. */
function spendableNoteValues(selected: 0 | 1): bigint[] {
  if (!keys || !visibleSnapshot) return [];
  const pending = session?.journal.unresolvedNullifiers() ?? new Set<bigint>();
  return visibleSnapshot.unspent.filter(owned => owned.note.asset === selected && owned.note.lockUntil <= visibleSnapshot!.head.timestamp && !pending.has(owned.nf)).map(owned => owned.note.value);
}
function renderMintQuote() {
  const form = document.querySelector<HTMLFormElement>('form[data-pane=mint]')!;
  form.dataset.source = mintSource;
  const payerPrompt = form.querySelector<HTMLElement>('.needs-payer')!;
  payerPrompt.hidden = submissionMode === 'export' && mintSource === 'private' ? true : !!payer;
  text('mint-submit', submissionMode === 'export' ? 'Generate authorization package'
    : nftSelfMint() ? 'Prove and self-submit' : mintSource === 'private' ? 'Prove and mint' : 'Pay and mint');
  if (!mintInfo) return;
  const count = Number(element<HTMLInputElement>('mint-count').value);
  if (count !== 1) { element('mint-total').replaceChildren(); return; }
  const native = nativeSymbol();
  const rows = [['Receive', `${formatUnits(mintInfo.lot * BigInt(count), 8)} ${mintInfo.symbol}`], ['Mint price', mintInfo.price === 0n ? 'Free' : `${formatUnits(mintInfo.price * BigInt(count), 18)} ${native}`]];
  element('mint-total').replaceChildren(...rows.flatMap(([label, value]) => [Object.assign(document.createElement('dt'), { textContent: label }), Object.assign(document.createElement('dd'), { textContent: value })]));
  text('mint-short', '');
  if (mintSource !== 'private') return;
  if (mintInfo.price === 0n) return;
  try {
    const { minimumTopup } = mintFunding(spendableNoteValues(1), mintInfo.price * BigInt(count), 0n);
    text('mint-short', minimumTopup
      ? `Deposit ${formatUnits(minimumTopup, 8)} ${native} to continue.`
      : '');
  } catch (reason) { text('mint-short', reason instanceof Error ? reason.message : String(reason)); }
}
element('mint-count').addEventListener('input', renderMintQuote);
for (const button of document.querySelectorAll<HTMLButtonElement>('#mint-source button')) button.addEventListener('click', () => {
  mintSource = button.dataset.source === 'public' ? 'public' : 'private';
  for (const peer of document.querySelectorAll<HTMLButtonElement>('#mint-source button')) { peer.classList.toggle('active', peer === button); peer.setAttribute('aria-pressed', String(peer === button)); }
  renderMintQuote();
});
element('claim-test-nft').addEventListener('click', () => {
  void (async () => {
    const activeConnection = connection, activePayer = payer, generation = viewGeneration;
    if (!activeConnection || !activePayer || activeConnection.config.mintPolicy?.mode !== 'nft-self') throw new Error('Connect a wallet to claim the test membership NFT');
    await claimTestNft(activeConnection, activePayer.client, () => {
      if (generation !== viewGeneration || connection !== activeConnection || payer !== activePayer) throw new Error('Wallet changed; review the claim again');
    });
    await refresh();
  })().catch(reason => ui.showError(String(reason)));
});
/** @orig index-CVtw0LZh.js:28302 DO.send / :28316 unshield Bind real witness/proof/relay flows. */
bindForm('form[data-pane=send]', async form => {
  const selectedAsset = asset;
  if (!session) throw new Error('Unlock the wallet and configure a network first');
  ensureSubmissionReady();
  const to = decodePrivateAddress(field(form, 'to')), amount = parseNoteAmount(field(form, 'amount'));
  const memo = new TextEncoder().encode(field(form, 'memo'));
  if (!await confirmOperation('Send privately', [['Amount', `${formatUnits(amount, 8)} ${selectedAsset === 1 ? nativeSymbol() : connection!.config.brand.tokenSymbol}`], ['To', encodePrivateAddress(to)], ['Submission', submissionMode === 'export' ? 'Authorization package only' : 'Submit now']], 'Your private notes will be locked to this proof. Do not create the payment again while an exported or submitted action is unresolved.')) return;
  await session.send({ to, amount, asset: selectedAsset, memo }, message => ui.setNetworkStatus(message, true));
  await refresh();
});
bindForm('form[data-pane=withdraw]', async form => {
  const selectedAsset = asset;
  if (!session) throw new Error('Unlock the wallet and configure a network first');
  ensureSubmissionReady();
  const recipient = field(form, 'recipient') as `0x${string}`;
  const amount = parseNoteAmount(field(form, 'amount'));
  if (!await confirmOperation('Withdraw to a public address', [['Amount', `${formatUnits(amount, 8)} ${selectedAsset === 1 ? nativeSymbol() : connection!.config.brand.tokenSymbol}`], ['To', recipient], ['Submission', submissionMode === 'export' ? 'Authorization package only' : 'Submit now']], 'The receiving public account and withdrawal amount are visible on chain.')) return;
  await session.withdraw({ recipient, amount, asset: selectedAsset }, message => ui.setNetworkStatus(message, true));
  await refresh();
});
bindForm('form[data-pane=consolidate]', async () => {
  const selectedAsset = asset;
  if (!session) throw new Error('Unlock the wallet and configure a network first');
  ensureSubmissionReady();
  if (!await confirmOperation('Merge private notes', [['Asset', selectedAsset === 1 ? nativeSymbol() : connection!.config.brand.tokenSymbol], ['Submission', submissionMode === 'export' ? 'Authorization package only' : 'Submit now']], 'Two existing notes will be spent and consolidated.')) return;
  await session.consolidate({ asset: selectedAsset }, message => ui.setNetworkStatus(message, true));
  await refresh();
});

/** @orig index-CVtw0LZh.js:22403 tE Runtime public config replaces original X Layer defaults. */
function bootNetwork(): Promise<void> {
  if (booting) return booting;
  booting = (async () => {
    ui.setNetworkStatus('Connecting to configured network…', true);
    if (new URLSearchParams(location.search).has('deployment')) {
      const currentUrl = new URL(location.href);
      currentUrl.searchParams.delete('deployment');
      history.replaceState(null, '', currentUrl);
    }
    const response = await fetch('/fresh-config.json', { cache: 'no-store' });
    if (response.status === 404) throw new Error('Current 404 deployment is unavailable. Retry after the site configuration is restored.');
    if (!response.ok) throw new Error(`Configuration HTTP ${response.status}`);
    const input = await response.json() as Omit<Protocol404ConfigInput, 'deployBlock'> & { deployBlock: string };
    connection = await openPool(create404Config({ ...input, signingProfiles: input.signingProfiles ?? { pool: '404', market: '404' }, deployBlock: BigInt(input.deployBlock) }));
    text('fee-settings-title', 'Wallet submission');
    element('portable-mint-warning').hidden = !nftSelfMint() || openPortableMint() || submissionMode !== 'export';
    viewGeneration++;
    createSession();
    renderSubmissionMode();
    void restoreAuthorizedPayer();
    await refresh();
  })().finally(() => { booting = null; });
  return booting;
}
function showNetworkError(reason: unknown) {
  element('network-retry').hidden = false;
  ui.setNetworkStatus(String(reason));
  text('mint-info', String(reason));
}
discoverInjectedProviders(providers => {
  injectedProviders = providers;
  renderInjectedProviders();
  void restoreAuthorizedPayer();
});
void bootNetwork().catch(showNetworkError);
