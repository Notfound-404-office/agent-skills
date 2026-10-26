/** Executes a generated dynamic import; generated prover imports have no preload dependencies. @orig web-ref/pretty/index-CVtw0LZh.js:4176 $a */
export function preload<T>(loader: () => Promise<T>): Promise<T> {
  return loader();
}

/** Converts proof bytes to the lowercase hexadecimal representation expected by Solidity. @orig web-ref/pretty/index-CVtw0LZh.js:1675 V */
export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return `0x${value}`;
}

/** Converts hexadecimal proof bytes, left-padding an odd nibble exactly like viem. @orig web-ref/pretty/index-CVtw0LZh.js:1743 U */
export function hexToBytes(value: string): Uint8Array {
  let digits = value.slice(2);
  if (digits.length % 2) digits = `0${digits}`;
  const bytes = new Uint8Array(digits.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
