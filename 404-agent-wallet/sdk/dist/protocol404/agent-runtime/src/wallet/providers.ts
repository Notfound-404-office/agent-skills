import {
  createWalletClient,
  custom,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type WalletClient,
} from "viem";

export interface InjectedProviderDescriptor {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly icon?: string;
  readonly provider: EIP1193Provider;
}

export interface ConnectedWallet {
  readonly address: Address;
  readonly label: string;
  readonly client: WalletClient;
  readonly injected: boolean;
}

interface Eip6963ProviderInfo {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
}

interface Eip6963Announcement {
  readonly info: Eip6963ProviderInfo;
  readonly provider: EIP1193Provider;
}

type ProviderWindow = Window & {
  ethereum?: EIP1193Provider;
  okxwallet?: EIP1193Provider;
};

type EventProvider = {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const INVALIDATING_EVENTS = ["accountsChanged", "chainChanged", "disconnect"] as const;

export interface InjectedWalletIdentity {
  readonly address: Address;
  readonly chainId: number;
}

/** Recognizes OKX providers so the original selector can place them first.*/
export function isOkxProvider(provider: Pick<InjectedProviderDescriptor, "key" | "name">): boolean {
  return /okx|okex/i.test(`${provider.key} ${provider.name}`);
}

/** Invalidates a connected payer when its injected provider identity changes. */
export function subscribeInjectedWalletInvalidation(
  provider: EIP1193Provider | EventProvider,
  onInvalidate: () => void,
  expected?: InjectedWalletIdentity,
): () => void {
  const eventProvider = provider as EventProvider;
  if (typeof eventProvider.on !== "function") return () => undefined;

  let active = true;
  const invalidate = (): void => {
    if (active) onInvalidate();
  };
  const accountsChanged = (accounts?: unknown): void => {
    if (!expected) return invalidate();
    const current = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof current !== "string" || current.toLowerCase() !== expected.address.toLowerCase()) invalidate();
  };
  const chainChanged = (chainId?: unknown): void => {
    if (!expected) return invalidate();
    try {
      if (Number(BigInt(chainId as string | number | bigint)) !== expected.chainId) invalidate();
    } catch {
      invalidate();
    }
  };
  const listeners = { accountsChanged, chainChanged, disconnect: invalidate } as const;
  for (const event of INVALIDATING_EVENTS) eventProvider.on(event, listeners[event]);

  return (): void => {
    if (!active) return;
    active = false;
    if (typeof eventProvider.removeListener !== "function") return;
    for (const event of INVALIDATING_EVENTS) eventProvider.removeListener(event, listeners[event]);
  };
}

/** Discovers EIP-6963 and legacy injected wallets.*/
export function discoverInjectedProviders(
  onChange: (providers: readonly InjectedProviderDescriptor[]) => void,
  browserWindow: ProviderWindow = window,
): void {
  const announced = new Map<string, InjectedProviderDescriptor>();
  const publish = (): void => {
    const providers = [...announced.values()];
    if (
      browserWindow.okxwallet &&
      !providers.some((item) => item.provider === browserWindow.okxwallet || isOkxProvider(item))
    ) {
      providers.push({
        id: "okxwallet",
        key: "okxwallet",
        name: "OKX Wallet",
        provider: browserWindow.okxwallet,
      });
    }
    if (browserWindow.ethereum && !providers.some((item) => item.provider === browserWindow.ethereum)) {
      providers.push({
        id: "injected",
        key: "injected",
        name: "Browser wallet",
        provider: browserWindow.ethereum,
      });
    }
    onChange(providers.sort((left, right) => Number(isOkxProvider(right)) - Number(isOkxProvider(left))));
  };

  browserWindow.addEventListener("eip6963:announceProvider", (event) => {
    const { info, provider } = (event as CustomEvent<Eip6963Announcement>).detail;
    announced.set(info.uuid, {
      id: info.uuid,
      key: info.rdns || info.name,
      name: info.name,
      icon: info.icon,
      provider,
    });
    publish();
  });
  browserWindow.addEventListener("ethereum#initialized", publish, { once: true });
  browserWindow.dispatchEvent(new Event("eip6963:requestProvider"));
  publish();
}

/** Connects or silently probes an injected wallet.*/
export async function connectInjectedWallet(
  provider: InjectedProviderDescriptor,
  chain: Chain,
  silent = false,
): Promise<ConnectedWallet | null> {
  const probe = createWalletClient({ chain, transport: custom(provider.provider) });
  const [address] = silent ? await probe.getAddresses() : await probe.requestAddresses();
  if (!address) {
    if (silent) return null;
    throw new Error("The wallet returned no account");
  }
  if (!silent) await ensureWalletChain(probe, chain);
  return {
    address,
    label: provider.name,
    client: createWalletClient({ chain, transport: custom(provider.provider), account: address }),
    injected: true,
  };
}

/** Creates the original local-node test wallet facade.*/
export function isLocalDevelopmentConnection(
  chainId: number,
  rpcUrl: string,
  pageUrl: string,
  localDevnet = false,
): boolean {
  if (chainId !== 97 && !(chainId === 56 && localDevnet === true)) return false;
  try {
    return [rpcUrl, pageUrl].every(value => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    });
  } catch { return false; }
}

export async function readLocalNodeAccounts(
  chain: Chain,
  rpcUrl: string,
  pageUrl: string,
  localDevnet = false,
): Promise<readonly Address[]> {
  if (!isLocalDevelopmentConnection(chain.id, rpcUrl, pageUrl, localDevnet)) throw new Error('Unlocked accounts are only available on a loopback devnet');
  const probe = createWalletClient({ chain, transport: http(rpcUrl) });
  const [chainId, accounts] = await Promise.all([probe.getChainId(), probe.getAddresses()]);
  if (chainId !== chain.id) throw new Error('The local RPC chain changed; reconnect');
  return accounts;
}

/** Keep the reviewed payer, including a non-first unlocked local account. */
export async function getConnectedWalletAccount(wallet: WalletClient, chainId: number): Promise<Address> {
  const addresses = await wallet.getAddresses();
  const selected = wallet.account?.address ?? addresses[0];
  if (!selected || !addresses.some(address => address.toLowerCase() === selected.toLowerCase())) {
    throw new Error('The connected wallet account changed; reconnect and review again');
  }
  if (await wallet.getChainId() !== chainId) throw new Error('Connect a wallet on the configured network');
  return selected;
}

/** Preserve a local signer; replacing it with an address selects RPC-side signing in viem. */
export function walletSigningAccount(wallet: WalletClient, reviewed: Address) {
  if (wallet.account?.type !== 'local') return reviewed;
  if (wallet.account.address.toLowerCase() !== reviewed.toLowerCase()) throw new Error('The signing account changed');
  return wallet.account;
}

/** Only call from the loopback-only developer account picker, never a public RPC. */
export function createLocalNodeWallet(address: Address, chain: Chain, rpcUrl: string): ConnectedWallet {
  return {
    address,
    label: "Local node test account",
    client: createWalletClient({ chain, transport: http(rpcUrl), account: address }),
    injected: false,
  };
}

/** Switches the wallet chain, adding it only for EIP-1193 error 4902.*/
export async function ensureWalletChain(client: WalletClient, chain: Chain): Promise<void> {
  if ((await client.getChainId()) === chain.id) return;
  try {
    await client.switchChain({ id: chain.id });
  } catch (error) {
    const walletError = error as { code?: number; cause?: { code?: number } };
    if ((walletError.code ?? walletError.cause?.code) !== 4902) throw error;
    await client.addChain({ chain });
  }
}
