/** Optional operator terminal input. Tool-calling Bots normally use a user-provisioned secret file. */
export async function hiddenPassword(label, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('PASSWORD_REQUIRED: the user must provision a local 0600 password file or unlock in a trusted terminal; never ask for the password in chat');
  output.write(label);
  const raw = input.isRaw;
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.removeListener('data', data); input.setRawMode(Boolean(raw)); input.pause(); output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const data = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') return finish(new Error('PASSWORD_INPUT_CANCELLED'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ' && char !== '\u001b') value += char;
      }
    };
    input.on('data', data);
  });
}
