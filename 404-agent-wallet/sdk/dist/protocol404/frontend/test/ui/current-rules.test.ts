import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('published guidance follows single-lot Mint and current market rules', () => {
  assert.doesNotMatch(html, /Up to 10 at a time|Pay from private BNB|no address of yours pays/);
  assert.match(html, /1 lot per transaction/);
  assert.match(html, /10 mints per submitting wallet/);
  assert.match(html, /older deployments show their on-chain Mint price and access rules/);
  assert.match(html, /any eligible public wallet can call the Mint router/);
  assert.match(html, /up to 20 listings in one transaction/);
  assert.match(html, /selected market's on-chain fee/);
  assert.match(html, /Unknown fields stay unknown/);
});
