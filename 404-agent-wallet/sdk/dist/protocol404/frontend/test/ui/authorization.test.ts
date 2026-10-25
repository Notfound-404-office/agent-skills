import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');

test('portable authorization UI is available without unlocking a private vault', () => {
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(topbar, /id="authorization-open"/);
  assert.match(html, /id="authorization-dialog"/);
  assert.match(html, /id="authorization-input"/);
  assert.match(html, /id="authorization-submit"/);
  assert.doesNotMatch(html, />Relayer fee</i);
  assert.doesNotMatch(html, /fixed 5%|service fee from/i);
});

test('import submission records unknown before wallet send and the hash afterwards', () => {
  const beforeSend = main.indexOf("beforeSend: async () => { assertCurrent(); writeAuthorizationState(id, { status: 'unknown' }); }");
  const submit = main.indexOf('const hash = await submitAuthorization');
  const persistedHash = main.indexOf("writeAuthorizationState(id, { status: 'submitted', hash });");
  assert.ok(submit >= 0 && beforeSend > submit && persistedHash > beforeSend);
  assert.match(main, /navigator\.locks\.request/);
  assert.match(main, /if \(readAuthorizationState\(id\)\) throw new Error/);
  assert.match(main, /onRejected:[\s\S]*localStorage\.removeItem\(authorizationStateKey\(id\)\)/);
});

test('damaged or invalid saved submission state fails closed', () => {
  const file = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(['authorizationStateKey', 'readAuthorizationState']);
  const declarations = file.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text));
  assert.equal(declarations.length, 2);
  let saved = '{';
  const context = vm.createContext({
    connection: { config: { chain: { id: 56 }, contracts: { pool: '0x1111111111111111111111111111111111111111' } } },
    localStorage: { getItem: () => saved },
  });
  const code = `${declarations.map(value => value.getText(file)).join('\n')}\nglobalThis.readAuthorizationState = readAuthorizationState;`;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const read = context.readAuthorizationState as (id: string) => unknown;
  assert.throws(() => read('id'), /damaged/);
  saved = '';
  assert.throws(() => read('id'), /damaged/);
  saved = JSON.stringify({ status: 'submitted', hash: '0x12' });
  assert.throws(() => read('id'), /damaged/);
});

test('authorization review formats public output and shows public recipient', () => {
  assert.match(main, /formatUnits\(BigInt\(description\.publicOut\), 8\)/);
  assert.match(main, /\['Public recipient', description\.recipient\]/);
  assert.match(main, /inspectedAuthorization = null;\s*element<HTMLButtonElement>\('authorization-submit'\)\.disabled = true;/);
});

test('free portable Mint has no embedded public top-up and does not require a gas wallet', () => {
  assert.match(main, /submissionMode === 'export' && mintSource === 'private' \? true : !!payer/);
  assert.match(main, /submissionMode === 'export' \? 'Generate authorization package'/);
  assert.match(main, /mintInfo\.price === 0n \? 'Free'/);
  assert.doesNotMatch(html, /id="mint-topup"|name="topup"|Add from public wallet/);
  assert.doesNotMatch(main, /element\('mint-topup'\)|field\(form, 'topup'\)|Public top-up first/);
  assert.match(main, /source === 'private' && info\.price > 0n/);
});

test('operation screens leave protocol rules in docs and retain amounts and safety controls', () => {
  const trading = readFileSync(new URL('../../src/ui/trading.ts', import.meta.url), 'utf8');
  const operations = html.slice(0, html.indexOf('<article class="doc"'));
  assert.doesNotMatch(operations, /pays (?:only )?network gas|Wallet gas only|id="mint-rules"|id="fee-settings-hint"|id="swap-fee"|NFT-gated self-submit/i);
  assert.doesNotMatch(main, /Connected (?:public )?wallet pays (?:network )?gas|Wallet pays gas only|Free Mint\. The submitting wallet pays network gas only/);
  assert.doesNotMatch(trading, /Public wallet gas only|byId\('swap-fee'\)/);
  assert.match(main, /\['Mint price', mintInfo\.price === 0n \? 'Free'/);
  assert.match(main, /\['Receive',/);
  assert.match(html, /id="claim-test-nft"/);
  assert.match(html, /id="authorization-warning"[^>]*>Anyone holding this text/);
  assert.match(trading, /\['Protocol fee',/);
  assert.match(trading, /\['Minimum received',/);
  const docs = html.slice(html.indexOf('<article class="doc"'));
  assert.match(docs, /data-doc="relayers"/);
  assert.match(docs, /pays network gas only/);
});

test('network boot is pinned to the fresh 404 configuration', () => {
  assert.match(main, /fetch\('\/fresh-config\.json', \{ cache: 'no-store' \}\)/);
  assert.doesNotMatch(main, /legacy-config|nft-test-config|nft-v1-config|nft-paid-config|fetch\('\/config\.json'/);
  assert.doesNotMatch(main, /deployment ===|loadedFresh|configPath/);
});

test('the page exposes no previous-pool switcher or legacy Mint panel', () => {
  assert.doesNotMatch(html, /id="deployment-mode"|id="deployment-current-link"|id="legacy-sepolia-mint"/);
  assert.doesNotMatch(html, /Return to original pool|Previous pools:|NFT v1|Paid NFT|Pools are independent/);
  assert.doesNotMatch(html, /\?deployment=/);
});

test('Mint keeps a submitted hash and only shows confirmation after journal observation', () => {
  assert.match(html, /id="mint-transaction" role="status" aria-live="polite"/);
  assert.match(main, /function renderPendingTransactions\(\) \{[\s\S]*?renderMintTransaction\(\);/);
  assert.match(main, /record\.status === 'observed' \? 'Mint confirmed on chain\. ' : 'Mint submitted/);
  assert.match(main, /marketTransactionUrl\(connection\.config\.chain\.id, record\.txHash\)/);
  assert.match(main, /ui\.setNetworkStatus\(message, true\);\s*renderPendingTransactions\(\);/);
  const file = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'renderMintTransaction');
  assert.ok(declaration);
  let records = [
    { intent: { kind: 'mint' }, status: 'submitted', txHash: '0xnew' },
    { intent: { kind: 'mint' }, status: 'observed', txHash: '0xold' },
  ];
  let children: any[] = [];
  const result = { hidden: true, replaceChildren: () => { children = []; }, append: (value: unknown) => children.push(value) };
  const context = vm.createContext({
    element: () => result, session: { pendingTransactions: () => records },
    connection: { config: { chain: { id: 11155111 } } }, document: { createElement: () => ({}) },
    marketTransactionUrl: (_chain: number, hash: string) => `https://sepolia.etherscan.io/tx/${hash}`,
  });
  vm.runInContext(ts.transpileModule(`${declaration.getText(file)}\nglobalThis.renderMintTransaction = renderMintTransaction;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const render = context.renderMintTransaction as () => void;
  render();
  assert.equal(result.hidden, false);
  assert.match(children[0], /submitted/);
  assert.equal(children[1].textContent, '0xnew');
  records[0]!.status = 'observed'; render();
  assert.match(children[0], /confirmed on chain/);
  records = []; render();
  assert.equal(result.hidden, true);
});
