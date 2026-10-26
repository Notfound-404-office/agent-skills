import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('displaying a new wallet backup clears the previous wallet confirmation', () => {
  const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const render = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'renderNewWords');
  assert.ok(render);
  const backedUp = { checked: true };
  let shown: string[] = [];
  const context = vm.createContext({
    newSeed: new Uint8Array(32).fill(1),
    element: (id: string) => id === 'backed-up' ? backedUp : {
      replaceChildren: (...words: { textContent: string }[]) => { shown = words.map(word => word.textContent); },
    },
    document: { createElement: () => ({}) },
    createMnemonicBackup: (seed: Uint8Array) => seed[0] === 1 ? 'first wallet words' : 'second wallet words',
  });
  vm.runInContext(ts.transpileModule(`${render.getText(file)}\nglobalThis.renderNewWords = renderNewWords;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const display = context.renderNewWords as () => void;
  display();
  assert.equal(backedUp.checked, false);
  assert.deepEqual(shown, ['first', 'wallet', 'words']);
  backedUp.checked = true;
  context.newSeed = new Uint8Array(32).fill(2);
  display();
  assert.equal(backedUp.checked, false);
  assert.deepEqual(shown, ['second', 'wallet', 'words']);
  assert.match(main, /if \(creating && !element<HTMLInputElement>\('backed-up'\)\.checked\) throw new Error/);
});
