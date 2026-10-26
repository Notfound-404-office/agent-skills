import assert from 'node:assert/strict';
import test from 'node:test';
import { PROTOCOL_NAME, protocolDocumentTitle, renderAssetTemplate } from '../../src/ui/branding.ts';

test('protocol titles use the 404 brand', () => {
  assert.equal(PROTOCOL_NAME, '404');
  assert.equal(protocolDocumentTitle(), '404');
  assert.equal(protocolDocumentTitle('Docs'), 'Docs · 404');
  assert.equal(protocolDocumentTitle('Keys and addresses'), 'Keys and addresses · 404 Docs');
});

test('asset templates update explicit placeholders without changing upstream provenance', () => {
  assert.equal(
    renderAssetTemplate('Upstream replica: mint {token} with {native}', { tokenSymbol: 'WALL', nativeSymbol: 'tBNB' }),
    'Upstream replica: mint WALL with tBNB',
  );
  assert.equal(renderAssetTemplate('{token} / {native}', { tokenSymbol: 'MY-TOKEN', nativeSymbol: 'BNB' }), 'MY-TOKEN / BNB');
});
