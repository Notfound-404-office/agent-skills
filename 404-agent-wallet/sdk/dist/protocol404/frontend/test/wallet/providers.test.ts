import assert from "node:assert/strict";
import test from "node:test";

import type { EIP1193Provider, WalletClient } from 'viem';
import { discoverInjectedProviders, getConnectedWalletAccount, isLocalDevelopmentConnection, subscribeInjectedWalletInvalidation } from "../../src/wallet/index.ts";

test("injected wallet events invalidate the payer until cleanup", () => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider = {
    request: async () => null,
    on(event: string, listener: (...args: unknown[]) => void) {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
    },
  };
  const emit = (event: string): void => {
    for (const listener of listeners.get(event) ?? []) listener();
  };

  let invalidations = 0;
  const cleanup = subscribeInjectedWalletInvalidation(provider, () => invalidations++);
  emit("accountsChanged");
  emit("chainChanged");
  emit("disconnect");
  assert.equal(invalidations, 3);

  cleanup();
  emit("accountsChanged");
  assert.equal(invalidations, 3);
  assert.equal([...listeners.values()].every((group) => group.size === 0), true);
});

test("redundant injected wallet events preserve the reviewed identity", () => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider = {
    on(event: string, listener: (...args: unknown[]) => void) {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
    },
  };
  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };

  let invalidations = 0;
  const cleanup = subscribeInjectedWalletInvalidation(provider, () => invalidations++, {
    address: "0x1111111111111111111111111111111111111111",
    chainId: 11155111,
  });
  emit("accountsChanged", ["0x1111111111111111111111111111111111111111"]);
  emit("accountsChanged", ["0x1111111111111111111111111111111111111111".toUpperCase()]);
  emit("chainChanged", "0xaa36a7");
  emit("chainChanged", 11155111);
  assert.equal(invalidations, 0);

  emit("accountsChanged", ["0x2222222222222222222222222222222222222222"]);
  emit("accountsChanged", []);
  emit("chainChanged", "0x1");
  emit("disconnect", { code: 4900 });
  assert.equal(invalidations, 4);

  cleanup();
  emit("accountsChanged", []);
  emit("chainChanged", "0x1");
  emit("disconnect");
  assert.equal(invalidations, 4);
  assert.equal([...listeners.values()].every((group) => group.size === 0), true);
});

test("late legacy injection is published once without polling", () => {
  const browserWindow = new EventTarget() as EventTarget & { ethereum?: EIP1193Provider };
  const snapshots: unknown[][] = [];
  discoverInjectedProviders(
    (providers) => snapshots.push([...providers]),
    browserWindow as unknown as Window,
  );
  assert.equal(snapshots.at(-1)?.length, 0);

  browserWindow.ethereum = { request: async () => null } as unknown as EIP1193Provider;
  browserWindow.dispatchEvent(new Event("ethereum#initialized"));
  assert.equal(snapshots.at(-1)?.length, 1);
  assert.equal((snapshots.at(-1)?.[0] as { provider?: unknown }).provider, browserWindow.ethereum);

  browserWindow.dispatchEvent(new Event("ethereum#initialized"));
  assert.equal(snapshots.length, 2);
});

test('unlocked node accounts require loopback, with chain 56 gated by the local-devnet flag', () => {
  const local = 'http://127.0.0.1:18545';
  assert.equal(isLocalDevelopmentConnection(97, local, 'http://localhost:4173'), true);
  assert.equal(isLocalDevelopmentConnection(97, 'http://[::1]:18545', 'http://[::1]:4173'), true);
  assert.equal(isLocalDevelopmentConnection(56, local, 'http://localhost:4173', true), true);
  for (const [chain, rpc, page, localDevnet] of [
    [56, local, 'http://localhost:4173', false],
    [56, 'https://bsc.example', 'http://localhost:4173', true],
    [97, 'https://bsc-testnet.example', 'http://localhost:4173', false],
    [97, local, 'https://public.example', false],
    [97, 'http://user@localhost:18545', 'http://localhost:4173', false],
    [97, 'http://localhost.example:18545', 'http://localhost:4173', false],
    [97, 'not a URL', 'http://localhost:4173', false],
  ] as const) assert.equal(isLocalDevelopmentConnection(chain, rpc, page, localDevnet), false);
  assert.equal(isLocalDevelopmentConnection(11155111, local, 'http://localhost:4173', true), false);
});

test('public payments keep the selected account instead of the first unlocked node account', async () => {
  const first = '0x1111111111111111111111111111111111111111';
  const selected = '0x2222222222222222222222222222222222222222';
  const wallet = {
    account: { address: selected }, getAddresses: async () => [first, selected], getChainId: async () => 97,
  } as unknown as WalletClient;
  assert.equal(await getConnectedWalletAccount(wallet, 97), selected);
  await assert.rejects(getConnectedWalletAccount({ ...wallet, getAddresses: async () => [first] } as WalletClient, 97), /account changed/);
  await assert.rejects(getConnectedWalletAccount(wallet, 56), /configured network/);
});
