import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForConfirmation } from '../../src/ui/confirmation.ts';

test('a dialog approves only its reviewed context and cannot share a second review', async () => {
  const dialog = Object.assign(new EventTarget(), { open: false, returnValue: 'confirm' }) as HTMLDialogElement;
  const open = () => { dialog.open = true; };
  const close = (value: string) => { dialog.returnValue = value; dialog.open = false; dialog.dispatchEvent(new Event('close')); };
  let generation = 1;
  const first = waitForConfirmation(dialog, open, () => generation === 1);
  assert.equal(dialog.returnValue, ''); // Never inherit an earlier approval.
  await assert.rejects(waitForConfirmation(dialog, open, () => true), /current transaction review/);
  generation++;
  close('confirm');
  assert.equal(await first, false); // A replaced/locked wallet cannot reuse approval.
  const cancelled = waitForConfirmation(dialog, open, () => true);
  close('cancel');
  assert.equal(await cancelled, false);
  const accepted = waitForConfirmation(dialog, open, () => true);
  close('confirm');
  assert.equal(await accepted, true);
  await assert.rejects(waitForConfirmation(dialog, () => { throw new Error('Cannot open'); }, () => true), /Cannot open/);
});
