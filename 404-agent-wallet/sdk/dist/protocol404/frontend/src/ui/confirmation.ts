/** A review approves only the context that opened it, never a replacement wallet. */
export function waitForConfirmation(dialog: HTMLDialogElement, open: () => void, isCurrent: () => boolean): Promise<boolean> {
  if (dialog.open) return Promise.reject(new Error('Finish the current transaction review first'));
  dialog.returnValue = '';
  return new Promise((resolve, reject) => {
    const closed = () => resolve(dialog.returnValue === 'confirm' && isCurrent());
    dialog.addEventListener('close', closed, { once: true });
    try { open(); }
    catch (error) { dialog.removeEventListener('close', closed); reject(error); }
  });
}
