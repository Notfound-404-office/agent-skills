import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('network boot retries after failure and coalesces concurrent attempts', async () => {
  const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'bootNetwork');
  assert.ok(declaration);

  let fetches = 0, opens = 0, refreshes = 0;
  const fetched: string[] = [];
  const location = { search: '?deployment=nft-paid', href: 'https://example.test/?deployment=nft-paid#/profile' };
  const replaced: string[] = [];
  const context = vm.createContext({
    URL, URLSearchParams, location,
    history: { replaceState: (_state: null, _title: string, url: URL) => {
      replaced.push(url.href);
      location.search = url.search;
      location.href = url.href;
    } },
    fetch: async (url: string) => {
      fetched.push(url);
      return ++fetches === 1
        ? { status: 404, ok: false }
        : { status: 200, ok: true, json: async () => ({ deployBlock: '7' }) };
    },
    openPool: async (config: unknown) => { opens++; return { config }; },
    create404Config: (input: unknown) => ({ ...(input as object), chain: { id: 97 } }),
    createSession: () => {},
    renderSubmissionMode: () => {},
    restoreAuthorizedPayer: async () => {},
    refresh: async () => { refreshes++; },
    element: () => ({ hidden: false }),
    text: () => {},
    nftSelfMint: () => false,
    ui: { setNetworkStatus: () => {} },
  });
  const code = `let booting = null, connection = null, viewGeneration = 0;\n${declaration.getText(file)}\nglobalThis.bootNetwork = bootNetwork;`;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const bootNetwork = context.bootNetwork as () => Promise<void>;

  const failed = bootNetwork();
  assert.equal(bootNetwork(), failed);
  await assert.rejects(failed, /Current 404 deployment is unavailable/);
  const retried = bootNetwork();
  assert.equal(bootNetwork(), retried);
  await retried;
  assert.deepEqual({ fetches, opens, refreshes }, { fetches: 2, opens: 1, refreshes: 1 });
  assert.deepEqual(fetched, ['/fresh-config.json', '/fresh-config.json']);
  assert.deepEqual(replaced, ['https://example.test/#/profile']);
});

test('treasury controls require the connected account to match the live treasury', () => {
  const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'isTreasuryPayer');
  assert.ok(declaration);
  const context = vm.createContext({});
  const code = `${declaration.getText(file)}\nglobalThis.isTreasuryPayer = isTreasuryPayer;`;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const matches = context.isTreasuryPayer as (payer: { address: string } | null, treasury: string) => boolean;
  assert.equal(matches({ address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
  assert.equal(matches({ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
  assert.equal(matches(null, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
});

test('wallet recovery silently restores only the saved provider/account/chain and ignores stale attempts', async () => {
  const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(['rememberedPayer', 'restoreAuthorizedPayer', 'connectPayer']);
  const declarations = file.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text));
  assert.equal(declarations.length, 3);
  const address = `0x${'1'.repeat(40)}`;
  let saved = JSON.stringify({ key: 'chosen.wallet', address });
  let chain = 97, returnedAddress = `0x${'2'.repeat(40)}`, activations = 0, calls = 0;
  let probe: (() => Promise<unknown>) | undefined;
  let expire = () => {};
  const context = vm.createContext({
    connection: { config: { chain: { id: 11155111 } } }, payer: null, restoringPayer: false, connectingPayer: false, payerAttempt: 0,
    injectedProviders: [{ key: 'other.wallet' }, { key: 'chosen.wallet' }],
    localStorage: { getItem: () => saved }, isAddress: (value: string) => /^0x[0-9a-f]{40}$/i.test(value),
    connectInjectedWallet: async (provider: { key: string }, _chain: unknown, silent?: boolean) => {
      calls++; assert.equal(provider.key, 'chosen.wallet');
      assert.equal(silent, context.connectingPayer ? undefined : true);
      return probe ? probe() : { address: returnedAddress, client: { getChainId: async () => chain } };
    },
    activateInjectedPayer: () => { activations++; }, refresh: async () => {}, ui: { showError: () => {}, closeDialog: () => {} },
    setTimeout: (callback: () => void) => { expire = callback; return 1; }, clearTimeout: () => {},
  });
  const code = `${declarations.map(value => value.getText(file)).join('\n')}\nglobalThis.restoreAuthorizedPayer = restoreAuthorizedPayer;\nglobalThis.connectPayer = connectPayer;`;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const restore = context.restoreAuthorizedPayer as () => Promise<void>;
  await restore(); assert.equal(activations, 0); // Different account.
  returnedAddress = address;
  await restore(); assert.equal(activations, 0); // Different chain.
  chain = 11155111;
  await restore(); assert.equal(activations, 1);
  saved = 'null';
  const previousCalls = calls;
  await restore(); assert.equal(calls, previousCalls); // Explicit disconnect is respected.
  saved = JSON.stringify({ key: 'chosen.wallet', address });
  let finish: (value: unknown) => void = () => {};
  probe = () => new Promise(resolve => { finish = resolve; });
  const stale = restore();
  context.payerAttempt++;
  finish({ address, client: { getChainId: async () => chain } });
  await stale; assert.equal(activations, 1);
  const timedOut = restore(); expire(); await timedOut;
  assert.equal(context.restoringPayer, false);
  finish({ address, client: { getChainId: async () => chain } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(activations, 1); // Late responses cannot reconnect after timeout.
  const manual = (context.connectPayer as (provider: { key: string }) => Promise<void>)({ key: 'chosen.wallet' });
  const callsDuringManual = calls, attemptDuringManual = context.payerAttempt;
  await restore(); // Wallet popup returning focus must not cancel the manual connection.
  assert.equal(calls, callsDuringManual);
  assert.equal(context.payerAttempt, attemptDuringManual);
  finish({ address, client: { getChainId: async () => chain } });
  await manual;
  assert.equal(activations, 2);
  assert.equal(context.connectingPayer, false);
});
