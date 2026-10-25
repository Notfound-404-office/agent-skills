import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { publicError } from './errors.mjs';
import { sdkCacheRoot } from './runtime.mjs';

test('local input, permission and balance failures retain safe actionable categories', () => {
  const cases = [
    [new Error('missing root'), 'MISSING_ARGUMENT', /--root/],
    [new Error('missing journalId'), 'MISSING_ARGUMENT', /--journal-id/],
    [Object.assign(new Error('private-path'), { code: 'ENOENT' }), 'FILE_NOT_FOUND', /local file/],
    [new Error('wallet directory must have mode 0700'), 'PRIVATE_FILE_PERMISSIONS', /0700/],
    [new Error('transaction journal must be a regular file with mode 0600'), 'PRIVATE_FILE_PERMISSIONS', /0600/],
    [new Error('wallet already exists; refusing to overwrite it'), 'FILE_ALREADY_EXISTS', /new path/],
    [new Error('insufficient spendable balance'), 'INSUFFICIENT_SPENDABLE_BALANCE', /balance.max/],
    [new Error('needs more than two notes: consolidate first'), 'CONSOLIDATION_REQUIRED', /merge/],
    [new Error('BAW_EXECUTABLE_NOT_FOUND'), 'BAW_EXECUTABLE_NOT_FOUND', /Install/],
    [new Error('BAW_COMMAND_EXIT_17: private output'), 'BAW_COMMAND_EXIT_17', /do not automatically repeat/],
    [new Error('QUOTE_STALE: private order data'), 'QUOTE_STALE', /fresh quote/],
    [new Error('SDK_ROOT_INVALID: private local path'), 'SDK_ROOT_INVALID', /override/],
    [new Error('SDK_ROOT_NOT_FOUND: private local path'), 'SDK_ROOT_NOT_FOUND', /setup.mjs/],
    [new Error('SDK_RELEASE_NOT_CONFIGURED: private metadata'), 'SDK_RELEASE_NOT_CONFIGURED', /public SDK source/],
    [new Error('SDK_RELEASE_INVALID: private metadata'), 'SDK_RELEASE_INVALID', /release metadata/],
    [Object.assign(new Error('Unknown file extension ".ts" for /private/sdk/frontend/src/wallet/index.ts'), { code: 'ERR_UNKNOWN_FILE_EXTENSION' }), 'NODE_FLAG_REQUIRED', /experimental-strip-types/],
    [new Error('EstimateGasExecutionError: revert 0x788a686f'), 'MARKET_REVERT_WRONG_PAYMENT', /payment asset/],
  ];
  for (const [error, code, message] of cases) {
    const exposed = publicError(error);
    assert.equal(exposed.code, code);
    assert.match(exposed.message, message);
    assert.equal(JSON.stringify(exposed).includes('private'), false, `leaked details for ${code}`);
  }
});

test('unknown errors and stacks never expose provider credentials or transaction payloads', () => {
  const error = new Error('RPC https://secret@host/seed?proof=private-payload');
  error.stack = 'private stack';
  assert.equal(publicError(error).code, 'OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(publicError(error)), /secret@|private-payload|private stack/);
  assert.equal(publicError(new Error('PRIVATE_SEED_VALUE')).code, 'OPERATION_FAILED');
});

test('CLI routes cancellation and public quote and diagnoses missing local input before unlock', async t => {
  const cli = fileURLToPath(new URL('./404.mjs', import.meta.url));
  const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
  const env = { ...process.env };
  delete env.PROTOCOL404_ROOT;
  const directory = await mkdtemp(resolve(tmpdir(), '404-cli-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const malformedFills = resolve(directory, 'fills.json');
  await writeFile(malformedFills, JSON.stringify([{ orderId: '1', pay: 'bad' }]));
  const checks = [
    [['wallet', 'address'], 'MISSING_ARGUMENT', /--wallet/],
    [['prepare', 'void', '--root', root], 'MISSING_ARGUMENT', /--journal-id/],
    [['quote', 'sweep', '--root', root, '--amount', '1.25', '--budget', '0.01', '--out', '/unused-fills'], 'MISSING_ARGUMENT', /--config/],
    [['prepare', 'fill', '--root', root], 'MISSING_ARGUMENT', /--protocol-fee/],
    [['baw', 'preview', '--root', root, '--config', '/unused-config'], 'MISSING_ARGUMENT', /--packet/],
    [['baw', 'execute', '--root', root, '--config', '/unused-config', '--packet', '/unused-packet'], 'MISSING_ARGUMENT', /--state/],
    [['prepare', 'sweep', '--root', root, '--config', '/unused-config', '--wallet', '/unused-wallet',
      '--password-file', '/unused-password', '--out', '/unused-packet', '--fills-file', malformedFills,
      '--min-bought', '1', '--protocol-fee', '0'], 'INVALID_FILLS_FILE', /quote sweep/],
  ];
  for (const [args, code, message] of checks) {
    await assert.rejects(promisify(execFile)(process.execPath, ['--experimental-strip-types', cli, ...args], { env }), error => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code);
      assert.match(result.error.message, message);
      return true;
    });
  }
});

test('a detached skill installation finds the cached SDK from any working directory', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), '404-portable-skill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = resolve(directory, 'custom agent', 'skills', '404-agent-wallet');
  await cp(fileURLToPath(new URL('..', import.meta.url)), installed, { recursive: true });
  const env = { ...process.env };
  delete env.PROTOCOL404_ROOT;
  env.XDG_CACHE_HOME = resolve(directory, 'sdk cache');
  env.PROTOCOL404_SDK_REPOSITORY = 'https://github.com/ORG/REPOSITORY.git';
  env.PROTOCOL404_SDK_REVISION = '0123456789abcdef0123456789abcdef01234567';
  const cache = sdkCacheRoot({ env });
  await mkdir(dirname(cache), { recursive: true });
  await symlink(fileURLToPath(new URL('../../../..', import.meta.url)), cache, 'dir');
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--experimental-strip-types', resolve(installed, 'scripts', '404.mjs'), 'doctor'], { cwd: directory, env });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data.dependencies, true);
  assert.equal(result.data.configured, false);
  assert.equal(result.data.authChecked, false);
});
