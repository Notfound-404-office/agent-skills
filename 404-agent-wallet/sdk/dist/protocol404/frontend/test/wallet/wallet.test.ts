import assert from "node:assert/strict";
import test from "node:test";

import {
  SCRYPT_PARAMS,
  createMnemonicBackup,
  decryptSeed,
  encryptSeed,
  parseWalletFile,
  restoreMnemonicBackup,
} from "../../src/wallet/index.ts";

test("wallet encryption round-trips and rejects a wrong password", { timeout: 120_000 }, async () => {
  const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
  const wallet = await encryptSeed(seed, "correct horse battery staple");

  assert.deepEqual(wallet.kdf, SCRYPT_PARAMS);
  assert.deepEqual(await decryptSeed(wallet, "correct horse battery staple"), seed);
  await assert.rejects(
    decryptSeed(wallet, "wrong password"),
    /wrong password or damaged wallet file/,
  );
});

test("wallet parser preserves original scrypt boundaries", () => {
  const valid = {
    version: 1,
    kdf: { name: "scrypt", N: 2 ** 15, r: 8, p: 4 },
    salt: `0x${"00".repeat(16)}`,
    nonce: `0x${"00".repeat(12)}`,
    seed: `0x${"00".repeat(48)}`,
  };
  assert.equal(parseWalletFile(valid).kdf.dkLen, 32);
  assert.doesNotThrow(() => parseWalletFile({ ...valid, salt: `0x${"0".repeat(33)}` }));
  assert.throws(() => parseWalletFile({ ...valid, kdf: { ...valid.kdf, N: 2 ** 14 } }), /not a compatible 404 wallet file/);
  assert.throws(() => parseWalletFile({ ...valid, kdf: { ...valid.kdf, N: 2 ** 15 + 1 } }), /not a compatible 404 wallet file/);
  assert.throws(() => parseWalletFile({ ...valid, kdf: { ...valid.kdf, p: 5 } }), /not a compatible 404 wallet file/);
});

test("32 zero bytes use the standard 24-word BIP-39 vector", () => {
  const seed = new Uint8Array(32);
  const backup = `${Array(23).fill("abandon").join(" ")} art`;
  assert.equal(createMnemonicBackup(seed), backup);
  assert.deepEqual(restoreMnemonicBackup(`  ${backup.toUpperCase()}\n`), seed);
  assert.throws(
    () => restoreMnemonicBackup("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
    /the backup must be 24 words/,
  );
});
