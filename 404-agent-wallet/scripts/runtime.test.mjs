import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertSetupRoot, bootstrapSdk, loadSdkRelease, resolveSdkRoot, sdkCacheRoot } from './runtime.mjs';

const REVISION = '0123456789abcdef0123456789abcdef01234567';
const RELEASE = { repository: 'https://github.com/ORG/REPOSITORY.git', revision: REVISION };

async function fixture(root, setup = false, layout = 'dist') {
  const agentRuntime = layout === 'dist' ? join(root, 'dist', 'protocol404', 'agent-runtime') : join(root, 'agent-runtime');
  const relayer = layout === 'dist' ? join(root, 'dist', 'protocol404', 'relayer') : join(root, 'relayer');
  await mkdir(join(agentRuntime, 'src', 'flows'), { recursive: true });
  await mkdir(join(relayer, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(agentRuntime, 'src', 'flows', 'session.ts'), '// fixture\n'),
    writeFile(join(agentRuntime, 'package.json'), '{}\n'),
    writeFile(join(agentRuntime, 'package-lock.json'), '{}\n'),
    writeFile(join(relayer, 'src', 'validators.ts'), '// fixture\n'),
    writeFile(join(relayer, 'package.json'), '{}\n'),
    writeFile(join(relayer, 'package-lock.json'), '{}\n'),
  ]);
  if (setup) {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, '.proof-assets'), { recursive: true });
    await writeFile(join(root, 'scripts', 'proof-assets.py'), '# fixture\n');
    await writeFile(join(root, '.proof-assets', 'manifest.json'), `${JSON.stringify([{
      paths: ['dist/protocol404/agent-runtime/public/assets/test.wasm'],
      source: '.proof-assets/test/test.wasm', size: 1, sha256: '00',
    }])}\n`);
  }
  return root;
}

test('explicit root wins and an invalid explicit root never falls back', async () => {
  const base = await mkdtemp(join(tmpdir(), 'protocol404-runtime-'));
  const valid = await fixture(join(base, 'valid'));
  const invalid = join(base, 'invalid');
  await mkdir(invalid);
  assert.equal(await resolveSdkRoot(valid, { cwd: valid, env: {} }), await realpath(valid));
  await assert.rejects(resolveSdkRoot(invalid, { cwd: valid, env: {} }), error => error.code === 'SDK_ROOT_INVALID');
  await assert.rejects(resolveSdkRoot('', { env: {}, home: base }), error => error.code === 'SDK_ROOT_INVALID');
  const incomplete = await fixture(join(base, 'agent-runtime-only'));
  await rm(join(incomplete, 'dist', 'protocol404', 'relayer'), { recursive: true });
  await assert.rejects(resolveSdkRoot(incomplete, { env: {} }), error => error.code === 'SDK_ROOT_INVALID');
});

test('environment root wins and an invalid environment root never falls back', async () => {
  const base = await mkdtemp(join(tmpdir(), 'protocol404-runtime-'));
  const valid = await fixture(join(base, 'valid'));
  assert.equal(await resolveSdkRoot(undefined, { cwd: base, env: { PROTOCOL404_ROOT: valid } }), await realpath(valid));
  await assert.rejects(resolveSdkRoot(undefined, { cwd: valid, env: { PROTOCOL404_ROOT: base } }), error => error.code === 'SDK_ROOT_INVALID');
  await assert.rejects(resolveSdkRoot(undefined, { cwd: valid, env: { PROTOCOL404_ROOT: '' } }), error => error.code === 'SDK_ROOT_INVALID');
});

test('unconfigured metadata fails closed while explicit roots remain usable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'protocol404-runtime-'));
  const releaseFile = join(base, 'sdk-release.json');
  await writeFile(releaseFile, '{"repository":"","revision":""}\n');
  await assert.rejects(loadSdkRelease({ env: {}, releaseFile }), error => error.code === 'SDK_RELEASE_NOT_CONFIGURED');
  const valid = await fixture(join(base, 'valid'));
  assert.equal(await resolveSdkRoot(valid, { env: {}, releaseFile }), await realpath(valid));
});

test('release metadata and environment overrides require a public HTTPS URL and full hash', async () => {
  assert.deepEqual(await loadSdkRelease({ env: {}, release: RELEASE }), RELEASE);
  assert.deepEqual(await loadSdkRelease({ env: {
    PROTOCOL404_SDK_REPOSITORY: RELEASE.repository,
    PROTOCOL404_SDK_REVISION: REVISION.toUpperCase(),
  } }), RELEASE);
  await assert.rejects(loadSdkRelease({ env: {}, release: { repository: 'https://user@example.com/repo', revision: REVISION } }), error => error.code === 'SDK_RELEASE_INVALID');
  await assert.rejects(loadSdkRelease({ env: {}, release: { repository: RELEASE.repository, revision: 'main' } }), error => error.code === 'SDK_RELEASE_INVALID');
  await assert.rejects(loadSdkRelease({ env: { PROTOCOL404_SDK_REPOSITORY: RELEASE.repository } }), error => error.code === 'SDK_RELEASE_NOT_CONFIGURED');
});

test('default resolution ignores cwd and uses only the configured versioned cache, including symlinks and spaces', async () => {
  const base = await mkdtemp(join(tmpdir(), 'protocol404-runtime-'));
  const foreign = await fixture(join(base, 'foreign-project'));
  const options = { cwd: foreign, env: { XDG_CACHE_HOME: join(base, 'cache with spaces') }, platform: 'linux', home: base, release: RELEASE };
  await assert.rejects(resolveSdkRoot(undefined, { ...options, bundledRoot: join(base, 'missing-bundled-sdk') }), error => error.code === 'SDK_ROOT_NOT_FOUND');
  const actual = await fixture(join(base, 'actual SDK'), true);
  const cached = sdkCacheRoot({ ...options, revision: REVISION });
  await mkdir(join(cached, '..'), { recursive: true });
  await symlink(actual, cached, 'dir');
  assert.equal(await resolveSdkRoot(undefined, { ...options, bundledRoot: join(base, 'missing-bundled-sdk') }), await realpath(actual));
});

test('uses platform cache locations without a Codex-specific path', () => {
  assert.equal(sdkCacheRoot({ env: { XDG_CACHE_HOME: '/cache' }, platform: 'linux', home: '/example/home', revision: REVISION }), join('/cache', 'protocol404', 'sdk', REVISION));
  assert.equal(sdkCacheRoot({ env: {}, platform: 'darwin', home: '/example/home', revision: REVISION }), join('/example/home', 'Library', 'Caches', 'protocol404', 'sdk', REVISION));
  assert.equal(sdkCacheRoot({ env: { LOCALAPPDATA: 'C:\\Local' }, platform: 'win32', home: 'C:\\Users\\Example', revision: REVISION }), `C:\\Local\\protocol404\\sdk\\${REVISION}`);
});

test('bootstrap executes the pinned Git plan and removes a failed temporary checkout', async () => {
  const base = await mkdtemp(join(tmpdir(), 'protocol404-runtime-'));
  const calls = [];
  const options = { env: { XDG_CACHE_HOME: base }, platform: 'linux', home: base, release: RELEASE };
  const installed = await bootstrapSdk({ ...options, run: async (command, args, commandOptions) => {
    calls.push([command, args]);
    if (args[0] === 'checkout') await fixture(commandOptions.cwd, true);
  } });
  assert.equal(installed, await realpath(sdkCacheRoot({ ...options, revision: REVISION })));
  assert.deepEqual(calls.map(([, args]) => args[0]), ['init', 'remote', 'fetch', 'checkout']);
  assert.deepEqual(calls[1][1].slice(-1), [RELEASE.repository]);
  assert.deepEqual(calls[2][1].slice(-2), ['origin', REVISION]);

  const incompatible = await fixture(join(base, 'custom-layout'), true, 'custom');
  await assert.rejects(assertSetupRoot(incompatible), error => error.code === 'SDK_ASSET_LAYOUT_INVALID');

  const failedBase = await mkdtemp(join(tmpdir(), 'protocol404-runtime-'));
  const failedOptions = { env: { XDG_CACHE_HOME: failedBase }, platform: 'linux', home: failedBase, release: RELEASE };
  await assert.rejects(bootstrapSdk({ ...failedOptions, run: async (_command, args) => {
    if (args[0] === 'fetch') throw new Error('network includes secret text');
  } }), error => error.code === 'SDK_BOOTSTRAP_FAILED' && !error.message.includes('secret text'));
  await assert.rejects(readFile(sdkCacheRoot({ ...failedOptions, revision: REVISION })), { code: 'ENOENT' });

  const occupied = sdkCacheRoot({ ...failedOptions, revision: REVISION });
  await mkdir(occupied, { recursive: true });
  const sentinel = join(occupied, 'keep-me');
  await writeFile(sentinel, 'unchanged');
  await assert.rejects(bootstrapSdk({ ...failedOptions, run: async () => assert.fail('must not run Git') }), error => error.code === 'SDK_CACHE_INVALID');
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
});
