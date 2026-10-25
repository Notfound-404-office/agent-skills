export type AssetLabels = { tokenSymbol: string; nativeSymbol: string };

export const PROTOCOL_NAME = '404';

export function protocolDocumentTitle(docTitle?: string): string {
  if (!docTitle) return PROTOCOL_NAME;
  return docTitle === 'Docs' ? `Docs · ${PROTOCOL_NAME}` : `${docTitle} · ${PROTOCOL_NAME} Docs`;
}

function validateLabels(labels: AssetLabels): void {
  const valid = (symbol: string) => symbol.length >= 1 && symbol.length <= 16
    && symbol.trim() === symbol && !/[\u0000-\u001f\u007f]/.test(symbol);
  if (!valid(labels.tokenSymbol) || !valid(labels.nativeSymbol)) {
    throw new Error('Asset symbols must be 1–16 display characters');
  }
}

/** Render explicit asset placeholders without touching attribution text. */
export function renderAssetTemplate(template: string, labels: AssetLabels): string {
  validateLabels(labels);
  return template.replace(/\{token\}|\{native\}/g, value =>
    value === '{token}' ? labels.tokenSymbol : labels.nativeSymbol);
}

function textNodes(root: Node): Text[] {
  const owner = root.nodeType === Node.DOCUMENT_NODE ? root as Document : root.ownerDocument;
  if (!owner) return [];
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function setExactLabel(element: Element, value: string): void {
  const node = textNodes(element).find(candidate => candidate.parentElement === element);
  if (node) node.data = node.data.replace(/^\s*.*?\s*$/, match => {
    const leading = match.match(/^\s*/)?.[0] ?? '';
    const trailing = match.match(/\s*$/)?.[0] ?? '';
    return `${leading}${value}${trailing}`;
  });
  else element.prepend(element.ownerDocument.createTextNode(value));
}

/**
 * Update metadata-marked labels while retaining every existing element/listener.
 * `data-assets` applies token/native templates to descendant text nodes; exact
 * `data-token` and `data-native` nodes are then normalized to the live symbols.
 */
export function renderAssetLabels(root: ParentNode, labels: AssetLabels): void {
  validateLabels(labels);
  const scopes: Element[] = [];
  if (root instanceof Element && root.matches('[data-assets]')) scopes.push(root);
  scopes.push(...root.querySelectorAll('[data-assets]'));
  for (const scope of scopes) {
    for (const node of textNodes(scope)) node.data = renderAssetTemplate(node.data, labels);
  }
  for (const node of root.querySelectorAll('[data-token]')) setExactLabel(node, labels.tokenSymbol);
  for (const node of root.querySelectorAll('[data-native]')) setExactLabel(node, labels.nativeSymbol);
}
