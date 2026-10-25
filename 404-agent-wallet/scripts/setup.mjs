#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { bootstrapSdk, frontendAt, relayerAt, resolveSdkRoot, runCommand, assertSetupRoot } from './runtime.mjs';

try {
  const { values } = parseArgs({ options: { root: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('node setup.mjs [--root EXISTING_404_CHECKOUT]\nUses the bundled SDK, circuits and proof assets; installs locked frontend and relayer dependencies and restores verified proof resources. Optional --root selects a trusted custom checkout. Requires Node.js, npm and Python 3. Never creates a wallet, contacts a chain or runs BAW.'); }
  else {
    let root;
    try { root = await resolveSdkRoot(values.root); }
    catch (error) {
      if (error.code !== 'SDK_ROOT_NOT_FOUND') throw error;
      root = await bootstrapSdk();
    }
    root = await assertSetupRoot(root);
    const frontend = await frontendAt(root);
    const relayer = await relayerAt(root);
    await runCommand('npm', ['ci', '--prefix', frontend], { stdio: ['ignore', 'inherit', 'inherit'] });
    await runCommand('npm', ['ci', '--prefix', relayer], { stdio: ['ignore', 'inherit', 'inherit'] });
    await runCommand('python3', [join(root, 'scripts', 'proof-assets.py'), 'restore'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    console.log(JSON.stringify({ ok: true, root, source: values.root !== undefined ? 'explicit' : Object.hasOwn(process.env, 'PROTOCOL404_ROOT') ? 'environment' : 'cache', next: 'Provide the reviewed public chain config when running chain operations.' }));
  }
} catch (error) {
  console.error(`Setup failed: ${error?.message ?? 'unknown error'}`);
  process.exitCode = 1;
}
