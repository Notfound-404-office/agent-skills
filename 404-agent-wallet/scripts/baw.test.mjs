import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeBaw, previewBaw, runBaw, statusBaw } from './baw.mjs';
import { FileJournalStore } from './file-store.mjs';

const from = `0x${'1'.repeat(40)}`, target = `0x${'2'.repeat(40)}`;
const now = () => 1_800_000_000_000;
async function fixture(t, { devModeExpiresAt = now() / 1000 + 600, previewExpiresAt = now() / 1000 + 120 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), '404-baw-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const opts = { packet: join(dir, 'packet.json'), state: join(dir, 'baw.json') };
  await writeFile(opts.packet, '{"authorization":"test-only"}', { mode: 0o600 });
  const inspected = { id: 'authorization-id', chainId: 56, operation: 'mint', intent: { kind: 'mint', count: '1' },
    call: { to: target, data: '0x12345678', value: '0' }, config: { chainId: 56 } };
  const calls = [];
  let executeResult = { status: 'PENDING_CONFIRMATION', orderId: 'order-id', txHash: null };
  const run = async args => {
    calls.push(args);
    if (args[0] === 'contract-call' && args[1] === 'preview') return {
      requestId: 'reviewed-request', expiresAt: previewExpiresAt, requireConfirmation: false,
      parsedTx: { contractAddress: target, amount: '0' },
      simulationResult: { simulationCode: '000000000', simulationErrorDetail: null, preCheckCode: '', balanceChanges: [], allowanceChanges: [], authorityChanges: ['review-this'] },
      risks: { riskDetails: ['review-all-risks'], addresses: {}, riskBehaviors: [] },
    };
    if (args[0] === 'contract-call' && args[1] === 'execute') {
      if (executeResult instanceof Error) throw executeResult;
      return executeResult;
    }
    if (args[1] === 'status') return { status: 'CONNECTED' };
    if (args[1] === 'chains') return [{ binanceChainId: '56' }];
    if (args[1] === 'address') return { addresses: [{ binanceChainId: '56', address: from }] };
    if (args[1] === 'settings') return { devMode: { enabled: true, expiresAt: devModeExpiresAt } };
    if (args[1] === 'tx-lock') return { status: 'UNLOCKED' };
    throw new Error('Unexpected mock command');
  };
  const deps = { attemptsRoot: join(dir, 'attempts'), run, inspect: async () => inspected, verify: async () => ({ gasEstimate: '250000' }), now };
  return { opts, inspected, calls, deps, setExecute: value => { executeResult = value; } };
}

function isoWithOffset(milliseconds) {
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

test('preview uses exact official BSC flags and exposes risks without full calldata', async t => {
  const f = await fixture(t);
  const result = await previewBaw(f.opts, f.deps);
  assert.deepEqual(f.calls.find(args => args[0] === 'contract-call'), [
    'contract-call', 'preview', '--binanceChainId', '56', '--from', from,
    '--to', target, '--value', '0', '--inputData', '0x12345678',
  ]);
  assert.deepEqual(result.risks.riskDetails, ['review-all-risks']);
  assert.deepEqual(result.simulationResult.authorityChanges, ['review-this']);
  assert.equal(JSON.stringify(result).includes('0x12345678'), false);
  assert.equal(f.calls.some(args => args[1] === 'execute'), false);
});

test('expiry accepts Binance ISO dates with timezone offsets', async t => {
  const devModeExpiresAt = isoWithOffset(now() + 600_000);
  const previewExpiresAt = isoWithOffset(now() + 120_000);
  const f = await fixture(t, { devModeExpiresAt, previewExpiresAt });
  const result = await previewBaw(f.opts, f.deps);
  assert.equal(result.expiresAt, new Date(Date.parse(previewExpiresAt)).toISOString());
});

test('expiry accepts seconds, milliseconds and numeric strings', async t => {
  const values = [
    now() / 1000 + 600,
    String(now() / 1000 + 600),
    now() + 600_000,
    String(now() + 600_000),
    `  ${now() + 600_000}  `,
  ];
  for (const value of values) {
    const f = await fixture(t, { devModeExpiresAt: value, previewExpiresAt: value });
    const result = await previewBaw(f.opts, f.deps);
    const numeric = typeof value === 'number' || /^\d+$/.test(value.trim());
    const number = typeof value === 'number' ? value : Number(value.trim());
    const expected = numeric && number < 1e12 ? number * 1000 : number;
    assert.equal(result.expiresAt, new Date(expected).toISOString());
  }
});

test('expired developer mode values, including exactly now, are rejected', async t => {
  const values = [
    isoWithOffset(now()),
    now() / 1000,
    String(now() / 1000),
    now(),
    String(now()),
    now() - 1,
    String(now() - 1),
  ];
  for (const value of values) {
    const f = await fixture(t, { devModeExpiresAt: value });
    await assert.rejects(previewBaw(f.opts, f.deps), /BAW_DEVELOPER_MODE_EXPIRED/);
  }
});

test('invalid expiry values are rejected', async t => {
  const values = ['', '   ', null, 'not-a-date', NaN, Infinity, -Infinity, 8.64e15 + 1,
    '999999-01-01T00:00:00Z'];
  for (const value of values) {
    const f = await fixture(t, { devModeExpiresAt: value });
    await assert.rejects(previewBaw(f.opts, f.deps), /BAW_INVALID_EXPIRY/);
  }
});

test('execution requires explicit state, exact confirmation, unchanged packet and config', async t => {
  const f = await fixture(t);
  await previewBaw(f.opts, f.deps);
  await assert.rejects(executeBaw({ ...f.opts, state: undefined, confirm: 'reviewed-request' }, f.deps), /BAW_STATE_REQUIRED/);
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'not-reviewed' }, f.deps), /USER_CONFIRMATION_REQUIRED/);
  f.inspected.config.changed = true;
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /REVIEWED_AUTHORIZATION_CHANGED/);
  delete f.inspected.config.changed;
  await writeFile(f.opts.packet, 'changed', { mode: 0o600 });
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /REVIEWED_AUTHORIZATION_CHANGED/);
  assert.equal(f.calls.some(args => args[1] === 'execute'), false);
});

test('sweep preview shows every purchase term and rejects changed intent before execution', async t => {
  const f = await fixture(t);
  f.inspected.operation = 'sweep';
  f.inspected.intent = { kind: 'sweep', asset: '1', amount: '301',
    fills: JSON.stringify([{ orderId: '7', pay: '100' }, { orderId: '9', pay: '200' }]),
    minBought: '500', protocolFee: '1' };
  const result = await previewBaw(f.opts, f.deps);
  assert.deepEqual(result.intent, f.inspected.intent);
  assert.equal(result.operation, 'sweep');
  f.inspected.intent.minBought = '1';
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /REVIEWED_AUTHORIZATION_CHANGED/);
  assert.equal(f.calls.some(args => args[1] === 'execute'), false);
});

test('pending execution is recorded once and never executed or previewed again', async t => {
  const f = await fixture(t);
  await previewBaw(f.opts, f.deps);
  const result = await executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps);
  assert.equal(result.phase, 'pending_confirmation');
  assert.deepEqual(f.calls.find(args => args[1] === 'execute'), ['contract-call', 'execute', '--requestId', 'reviewed-request']);
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /BAW_ALREADY_ATTEMPTED/);
  await assert.rejects(previewBaw(f.opts, f.deps), /BAW_ALREADY_ATTEMPTED/);
  assert.equal(f.calls.filter(args => args[1] === 'execute').length, 1);
});

test('unknown execution is frozen before BAW and blocks retries', async t => {
  const f = await fixture(t);
  await previewBaw(f.opts, f.deps);
  const run = f.deps.run;
  f.deps.run = async args => {
    if (args[1] === 'execute') assert.equal(JSON.parse(await readFile(f.opts.state, 'utf8')).phase, 'executing');
    return run(args);
  };
  f.setExecute(new Error('BAW_COMMAND_FAILED'));
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /BAW_COMMAND_FAILED/);
  assert.equal(JSON.parse(await readFile(f.opts.state, 'utf8')).phase, 'unknown');
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /BAW_ALREADY_ATTEMPTED/);
});

test('wrong chain and expired previews cannot execute', async t => {
  const f = await fixture(t);
  f.inspected.chainId = 11155111;
  await assert.rejects(previewBaw(f.opts, f.deps), /ONLY_BSC/);
  assert.equal(f.calls.length, 0);
  f.inspected.chainId = 56;
  await previewBaw(f.opts, f.deps);
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, { ...f.deps, now: () => now() + 121_000 }), /BAW_PREVIEW_EXPIRED/);
  assert.equal(f.calls.some(args => args[1] === 'execute'), false);
});


test('alternate state files cannot submit the same authorization twice', async t => {
  const f = await fixture(t);
  const other = { ...f.opts, state: join(f.opts.state + '.other.json') };
  await previewBaw(f.opts, f.deps);
  await previewBaw(other, f.deps);
  await executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps);
  await assert.rejects(executeBaw({ ...other, confirm: 'reviewed-request' }, f.deps), /BAW_ALREADY_ATTEMPTED/);
  const status = await statusBaw({ state: other.state }, f.deps);
  assert.equal(status.phase, 'unknown');
  assert.equal(status.attempted, true);
  assert.equal(status.attemptedState, f.opts.state);
  assert.equal(status.attemptedRequestId, 'reviewed-request');
  assert.equal(f.calls.filter(args => args[1] === 'execute').length, 1);
});

test('incomplete risk data and unknown simulation codes stop before saving preview', async t => {
  const f = await fixture(t);
  const run = f.deps.run;
  f.deps.run = async args => {
    const result = await run(args);
    if (args[1] === 'preview') delete result.risks;
    return result;
  };
  await assert.rejects(previewBaw(f.opts, f.deps), /BAW_INVALID_PREVIEW/);
  f.deps.run = async args => {
    const result = await run(args);
    if (args[1] === 'preview') result.simulationResult.simulationCode = 'UNKNOWN';
    return result;
  };
  await assert.rejects(previewBaw(f.opts, f.deps), /BAW_SIMULATION_FAILED/);
  assert.equal(f.calls.some(args => args[1] === 'execute'), false);
});

test('an attempt marker makes an interrupted preview state unknown without requiring BAW', async t => {
  const f = await fixture(t);
  await previewBaw(f.opts, f.deps);
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, {
    ...f.deps, save: async () => { throw new Error('simulated crash before state save'); },
  }), /simulated crash/);
  assert.equal(f.calls.some(args => args[1] === 'execute'), false);

  const unavailable = async () => { throw new Error('BAW_EXECUTABLE_NOT_FOUND'); };
  const status = await statusBaw({ state: f.opts.state }, { ...f.deps, run: unavailable });
  assert.equal(status.phase, 'unknown');
  assert.equal(status.recordedPhase, 'preview');
  assert.equal(status.attempted, true);
  assert.equal(status.diagnostics.wallet, 'BAW_EXECUTABLE_NOT_FOUND');
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /BAW_ALREADY_ATTEMPTED/);
});

test('saved preview identity and simulation cannot be changed before execution', async t => {
  const f = await fixture(t);
  await previewBaw(f.opts, f.deps);
  const original = JSON.parse(await readFile(f.opts.state, 'utf8'));

  const changedRequest = structuredClone(original);
  changedRequest.preview.requestId = 'different-request';
  await writeFile(f.opts.state, JSON.stringify(changedRequest), { mode: 0o600 });
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /INVALID_BAW_STATE/);

  const changedExpiry = structuredClone(original);
  changedExpiry.preview.expiresAt += 1;
  await writeFile(f.opts.state, JSON.stringify(changedExpiry), { mode: 0o600 });
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /INVALID_BAW_STATE/);

  const changedSimulation = structuredClone(original);
  changedSimulation.preview.simulationResult.simulationCode = 'UNKNOWN';
  await writeFile(f.opts.state, JSON.stringify(changedSimulation), { mode: 0o600 });
  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, f.deps), /BAW_SIMULATION_FAILED/);
  assert.equal(f.calls.some(args => args[1] === 'execute'), false);
});

test('state, attempt and journal reads require private regular files', async t => {
  const f = await fixture(t);
  await previewBaw(f.opts, f.deps);
  await chmod(f.opts.state, 0o644);
  await assert.rejects(statusBaw({ state: f.opts.state }, f.deps), /mode 0600/);
  await chmod(f.opts.state, 0o600);

  await assert.rejects(executeBaw({ ...f.opts, confirm: 'reviewed-request' }, {
    ...f.deps, save: async () => { throw new Error('simulated crash'); },
  }), /simulated crash/);
  const [attemptName] = await readdir(f.deps.attemptsRoot);
  await chmod(join(f.deps.attemptsRoot, attemptName), 0o644);
  await assert.rejects(statusBaw({ state: f.opts.state }, f.deps), /mode 0600/);

  const journal = join(f.opts.state + '.journal.json');
  await writeFile(journal, '[]', { mode: 0o644 });
  await assert.rejects(new FileJournalStore(journal).readAll(), /mode 0600/);
});

test('runBaw reports safe process failure categories without leaking subprocess output', async () => {
  const failures = [
    [{ code: 'ENOENT', stderr: 'secret' }, /BAW_EXECUTABLE_NOT_FOUND/],
    [{ killed: true, stderr: 'secret' }, /BAW_COMMAND_TIMEOUT/],
    [{ signal: 'SIGTERM', stderr: 'secret' }, /BAW_COMMAND_SIGNALLED_SIGTERM/],
    [{ code: 17, stderr: 'secret' }, /BAW_COMMAND_EXIT_17/],
  ];
  for (const [failure, expected] of failures) {
    await assert.rejects(runBaw(['wallet', 'status'], { exec: async () => { throw failure; } }), error => {
      assert.match(error.message, expected);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
});
