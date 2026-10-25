import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// The production static server consumes this plain Node helper directly.
// @ts-expect-error The runtime helper intentionally has no TypeScript wrapper.
import { cacheControlFor } from '../../scripts/cache-policy.mjs';

test('only fixed proof resources receive immutable caching', () => {
  for (const pathname of [
    '/assets/acvm_js_bg-BawCIsJQ.wasm',
    '/assets/barretenberg-Bwi_mQhV.js',
    '/assets/barretenberg-threads-CQu7x8-M.js',
    '/assets/noirc_abi_wasm_bg-VozwQxgy.wasm',
    '/assets/hold-KmcNW90K.js',
    '/crs/bn254_g1_compressed_131072.dat',
    '/crs/bn254_g2.dat',
  ]) {
    assert.equal(cacheControlFor(pathname), 'public, max-age=31536000, immutable');
  }

  for (const pathname of [
    '/',
    '/index.html',
    '/assets/app.js',
    '/assets/app.css',
    '/config.json',
    '/assets/not-pinned.js',
    '/assets/barretenberg-Bwi_mQhV.js.map',
    '/assets/transfer-BxYyEYeL.js',
    '/assets/transfer-u32.js',
  ]) {
    assert.equal(cacheControlFor(pathname), 'no-store');
  }
});

test('the HTTPS proxy preserves the same allowlist and never caches error responses', () => {
  const nginx = readFileSync(new URL('../../../../../bsc-deploy/server/nginx-https.conf', import.meta.url), 'utf8');
  assert.match(nginx, /map "\$status:\$uri" \$protocol404_cache_control \{\s*default no-store;/);
  const paths = [...nginx.matchAll(/"200:([^"\n]+)" "public, max-age=31536000, immutable";/g)].map(match => match[1]);
  assert.equal(paths.length, 7);
  for (const path of paths) assert.equal(cacheControlFor(path), 'public, max-age=31536000, immutable');
  assert.match(nginx, /add_header Cache-Control \$protocol404_cache_control always;/);
});
