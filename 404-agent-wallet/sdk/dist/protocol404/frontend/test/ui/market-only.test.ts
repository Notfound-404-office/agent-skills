import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('market-only shell omits AMM entry points while retaining archived markup', () => {
  const nav = html.slice(html.indexOf('<nav class="nav"'), html.indexOf('</nav>') + 6);
  const feeOperations = html.slice(html.indexOf('<select id="fee-operation"'), html.indexOf('</select>', html.indexOf('<select id="fee-operation"')));

  assert.doesNotMatch(nav, /#\/trade|>Trade</);
  assert.doesNotMatch(feeOperations, /value="swap"/);
  assert.match(html, /<article class="frame" data-archived="amm" hidden>[\s\S]*?<h3>Trade<\/h3>/);
  assert.match(html, /id="page-trade"[^>]*data-archived="amm"[^>]*hidden/);
  assert.match(html, /data-doc="swap"[^>]*data-archived="amm"[^>]*hidden/);
});

test('shell presents 404 branding and runtime asset labels', () => {
  assert.match(html, /<title>404<\/title>/);
  assert.match(html, /class="brand-name">404<\/span>/);
  assert.match(html, /<p class="band-sign">404\. Live on BNB Smart Chain\.<\/p>/);
  assert.match(html, /Pay any 4041 address in \{token\} or BNB/);
  assert.doesNotMatch(html, /class="brand-name">(?:BigWall)<\/span>/);
});
