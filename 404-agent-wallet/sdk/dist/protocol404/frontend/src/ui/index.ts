/**
 * Native-DOM shell for the 404 interface.
 * @orig pretty/index-CVtw0LZh.js:28838 RO, 29150 yk, 29155 bk
 */

import { initDotAnimations } from "./animation.ts";
import { AMM_ENABLED } from "../config/release.ts";
import { protocolDocumentTitle } from "./branding.ts";

export const ROUTES = ["home", "mint", "operation", "market", "profile", "docs"] as const;
export type Route = (typeof ROUTES)[number];

export interface RouteState {
  route: Route;
  docSlug: string;
}

export interface WalletUIState {
  hasVault: boolean;
  unlocked: boolean;
}

export interface UIHandlers {
  onWalletOpen?: () => void | Promise<void>;
  onConnect?: () => void | Promise<void>;
  onLock?: () => void | Promise<void>;
  onRouteChange?: (state: RouteState) => void;
  onOrderOpen?: (side: "buy" | "sell") => void;
}

export interface UIController {
  getRoute(): RouteState;
  navigate(route: Route, docSlug?: string): void;
  renderRoute(): void;
  setWalletState(state: Partial<WalletUIState>): void;
  setNetworkStatus(message: string, busy?: boolean): void;
  openDialog(id: string): void;
  closeDialog(id: string): void;
  showError(message: string, title?: string): void;
  destroy(): void;
}

const DEFAULT_DOC = "overview";

/** Parse the hash exactly as the original router does, with unknown routes falling home. */
export function parseRoute(hash: string, knownDocs: readonly string[] = []): RouteState {
  const [candidate = "", requestedDoc = ""] = hash.replace(/^#\/?/, "").split(/[/?]/);
  const routeCandidate = !AMM_ENABLED && (candidate === "trade" || candidate === "swap") ? "market" : candidate;
  const route = (ROUTES as readonly string[]).includes(routeCandidate) ? routeCandidate as Route : "home";
  const docCandidate = !AMM_ENABLED && requestedDoc === "swap" ? "market" : requestedDoc;
  const docSlug = knownDocs.includes(docCandidate) ? docCandidate : knownDocs[0] ?? DEFAULT_DOC;
  return { route, docSlug };
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing original UI element #${id}`);
  return element as T;
}

function docs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("article.doc")]
    .filter(article => AMM_ENABLED || article.dataset.doc !== "swap");
}

/**
 * Build the original documentation sidebar and select from article metadata.
 * @orig pretty/index-CVtw0LZh.js:29186 Tk
 */
function initDocs(): void {
  const nav = byId<HTMLElement>("docs-nav");
  const select = byId<HTMLSelectElement>("docs-select");
  if (nav.childElementCount || select.childElementCount) return;

  let group = "";
  let options: HTMLOptGroupElement | null = null;
  for (const article of docs()) {
    const { doc = "", title = "", group: nextGroup = "" } = article.dataset;
    if (nextGroup !== group) {
      group = nextGroup;
      options = Object.assign(document.createElement("optgroup"), { label: group });
      select.append(options);
      nav.append(Object.assign(document.createElement("p"), { className: "docs-group", textContent: group }));
    }
    const link = Object.assign(document.createElement("a"), {
      className: "docs-link",
      href: `#/docs/${doc}`,
      textContent: title,
    });
    link.dataset.doc = doc;
    nav.append(link);
    options?.append(Object.assign(document.createElement("option"), { value: doc, textContent: title }));

    for (const heading of article.querySelectorAll<HTMLElement>("h2")) {
      const slug = (heading.textContent ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      heading.id = `${doc}--${slug}`;
    }
  }
}

/** @orig pretty/index-CVtw0LZh.js:29216 Ek */
function renderDocs(state: RouteState): void {
  const articles = docs();
  const activeIndex = Math.max(0, articles.findIndex(article => article.dataset.doc === state.docSlug));
  const active = articles[activeIndex];
  if (!active) return;

  for (const article of articles) article.hidden = article !== active;
  for (const link of byId("docs-nav").querySelectorAll<HTMLAnchorElement>("a[data-doc]")) {
    const selected = link.dataset.doc === state.docSlug;
    link.classList.toggle("active", selected);
    if (selected) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  byId<HTMLSelectElement>("docs-select").value = state.docSlug;

  const toc = byId("docs-toc-list");
  toc.replaceChildren(...[...active.querySelectorAll<HTMLElement>("h2")].map(heading => {
    const link = Object.assign(document.createElement("a"), {
      href: `#/docs/${state.docSlug}`,
      textContent: heading.textContent,
    });
    link.dataset.target = heading.id;
    return Object.assign(document.createElement("li"), {}).appendChild(link).parentElement!;
  }));

  const pagerLink = (article: HTMLElement | undefined, direction: "prev" | "next"): HTMLElement => {
    if (!article) return document.createElement("span");
    const link = Object.assign(document.createElement("a"), {
      className: direction,
      href: `#/docs/${article.dataset.doc}`,
    });
    link.append(
      Object.assign(document.createElement("small"), { textContent: direction === "prev" ? "Previous" : "Next" }),
      article.dataset.title ?? "",
    );
    return link;
  };
  byId("doc-pager").replaceChildren(pagerLink(articles[activeIndex - 1], "prev"), pagerLink(articles[activeIndex + 1], "next"));
  document.title = protocolDocumentTitle(activeIndex === 0 ? "Docs" : active.dataset.title);
  updateDocsToc();
}

/** @orig pretty/index-CVtw0LZh.js:28882 VO */
function initTabs(id: string): void {
  const tabs = byId(id);
  const card = tabs.closest<HTMLElement>(".card");
  if (!card) return;
  for (const button of tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]")) {
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(button.classList.contains("active")));
  }
  tabs.addEventListener("click", event => {
    const selected = (event.target as Element).closest<HTMLButtonElement>("button[data-tab]");
    if (!selected) return;
    for (const button of tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]")) {
      const active = button === selected;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const pane of card.querySelectorAll<HTMLElement>("[data-pane]")) pane.hidden = pane.dataset.pane !== selected.dataset.tab;
    if (id === "action-tabs") byId("asset-row").hidden = selected.dataset.tab === "receive";
  });
}

function initPressedGroup(id: string, attribute: string): void {
  const group = byId(id);
  group.addEventListener("click", event => {
    const selected = (event.target as Element).closest<HTMLButtonElement>(`button[data-${attribute}]`);
    if (!selected) return;
    for (const button of group.querySelectorAll<HTMLButtonElement>(`button[data-${attribute}]`)) {
      const active = button === selected;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  });
}

/** Keep the original documentation table of contents aligned with scroll. */
function updateDocsToc(): void {
  if (parseRoute(location.hash).route !== "docs") return;
  const links = [...byId("docs-toc-list").querySelectorAll<HTMLAnchorElement>("a[data-target]")];
  let active = links[0];
  for (const link of links) {
    const heading = document.getElementById(link.dataset.target ?? "");
    if (heading && heading.getBoundingClientRect().top < 160) active = link;
  }
  for (const link of links) link.classList.toggle("active", link === active);
}

/** Initialize the exact original DOM shell while leaving wallet and chain work to main.ts. */
export function initUI(handlers: UIHandlers = {}): UIController {
  initDotAnimations();
  initDocs();
  initTabs("onboard-tabs");
  initTabs("action-tabs");
  initPressedGroup("asset-switch", "asset");
  initPressedGroup("mint-source", "source");
  initPressedGroup("market-tabs", "view");
  initPressedGroup("notes-filter", "filter");
  initPressedGroup("slippage", "bps");

  let wallet: WalletUIState = { hasVault: false, unlocked: false };
  let previous = "";
  const removers: Array<() => void> = [];
  const listen = <K extends keyof WindowEventMap>(target: Window, type: K, listener: (event: WindowEventMap[K]) => void): void => {
    target.addEventListener(type, listener as EventListener);
    removers.push(() => target.removeEventListener(type, listener as EventListener));
  };
  const onClick = (element: HTMLElement, listener: (event: MouseEvent) => void): void => {
    element.addEventListener("click", listener);
    removers.push(() => element.removeEventListener("click", listener));
  };

  const knownDocs = (): string[] => docs().map(article => article.dataset.doc ?? "");
  const getRoute = (): RouteState => parseRoute(location.hash, knownDocs());

  const renderRoute = (): void => {
    const state = getRoute();
    if (!AMM_ENABLED && location.hash === "#/trade") history.replaceState(null, "", "#/market");
    if (!AMM_ENABLED && location.hash === "#/swap") history.replaceState(null, "", "#/market");
    if (!AMM_ENABLED && location.hash === "#/docs/swap") history.replaceState(null, "", "#/docs/market");
    const selected = byId<HTMLElement>(`page-${state.route}`);
    const gated = selected.hasAttribute("data-wallet") && !wallet.unlocked;
    for (const page of document.querySelectorAll<HTMLElement>(".page[data-page]")) page.hidden = page !== selected || gated;
    byId("gate").hidden = !gated;
    byId("screen-onboard").hidden = wallet.hasVault;
    byId("screen-unlock").hidden = !wallet.hasVault;
    document.body.classList.toggle("gated", gated);
    document.body.dataset.route = state.route;
    byId("wallet-bar").hidden = !wallet.unlocked || state.route === "home" || state.route === "docs";

    for (const link of document.querySelectorAll<HTMLAnchorElement>("#nav a[data-route]")) {
      const active = link.dataset.route === state.route;
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    if (state.route === "docs") renderDocs(state); else document.title = protocolDocumentTitle();
    const identity = `${state.route}/${state.docSlug}`;
    if (identity !== previous) {
      previous = identity;
      window.scrollTo(0, 0);
      handlers.onRouteChange?.(state);
    }
  };

  const setWalletState = (state: Partial<WalletUIState>): void => {
    wallet = { ...wallet, ...state };
    const walletButton = byId<HTMLButtonElement>("wallet-btn");
    walletButton.hidden = wallet.unlocked;
    walletButton.textContent = wallet.hasVault ? "Unlock" : "Create wallet";
    byId("lock").hidden = !wallet.unlocked;
    byId("home-wallet-link").textContent = wallet.unlocked ? "Your wallet" : wallet.hasVault ? "Unlock wallet" : "Create a wallet";
    renderRoute();
  };

  const openDialog = (id: string): void => {
    const dialog = byId<HTMLDialogElement>(id);
    if (!dialog.open) dialog.showModal();
  };
  const closeDialog = (id: string): void => byId<HTMLDialogElement>(id).close();
  const showError = (message: string, title = "Unable to continue"): void => {
    byId("error-dialog-title").textContent = title;
    byId("error-dialog-message").textContent = message;
    openDialog("error-dialog");
  };

  const walletOpen = (): void => {
    if (getRoute().route === "home" || !byId(`page-${getRoute().route}`).hasAttribute("data-wallet")) location.hash = "#/profile";
    void handlers.onWalletOpen?.();
  };
  onClick(byId("wallet-btn"), walletOpen);
  onClick(byId("home-wallet-link"), event => { event.preventDefault(); walletOpen(); });
  onClick(byId("lock"), () => void handlers.onLock?.());
  const connect = (): void => { openDialog("connect-dialog"); void handlers.onConnect?.(); };
  onClick(byId("connect"), connect);
  for (const button of document.querySelectorAll<HTMLElement>("[data-connect]")) onClick(button, connect);
  onClick(byId("connect-close"), () => closeDialog("connect-dialog"));
  onClick(byId("error-dialog-close"), () => closeDialog("error-dialog"));
  onClick(byId("password-dialog-cancel"), () => closeDialog("password-dialog"));
  onClick(byId("confirm-cancel"), () => closeDialog("confirm-dialog"));
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
    onClick(dialog, event => {
      if (event.target === dialog || (event.target as Element).closest("[data-close]")) dialog.close();
    });
  }
  const openOrder = (side: "buy" | "sell"): void => {
    const selling = side === "sell";
    byId("order-title").textContent = selling ? "List tokens" : "Make offer";
    byId("order-submit").textContent = selling ? "List privately" : "Offer privately";
    byId<HTMLFormElement>("order-form").dataset.side = side;
    openDialog("order-dialog");
    handlers.onOrderOpen?.(side);
  };
  onClick(byId("list-open"), () => openOrder("sell"));
  onClick(byId("offer-open"), () => openOrder("buy"));
  byId<HTMLSelectElement>("docs-select").addEventListener("change", event => {
    location.hash = `#/docs/${(event.target as HTMLSelectElement).value}`;
  });
  byId("docs-toc").addEventListener("click", event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[data-target]");
    if (!link) return;
    event.preventDefault();
    document.getElementById(link.dataset.target ?? "")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  const maskButton = byId("mask-toggle");
  const setMasked = (masked: boolean): void => {
    document.body.classList.toggle("masked", masked);
    maskButton.setAttribute("aria-pressed", String(masked));
    maskButton.title = masked ? "Show amounts" : "Hide amounts";
    try { localStorage.setItem("pm.mask", masked ? "1" : "0"); } catch { /* storage may be disabled */ }
  };
  try { setMasked(localStorage.getItem("pm.mask") === "1"); } catch { setMasked(false); }
  onClick(maskButton, () => setMasked(!document.body.classList.contains("masked")));
  listen(window, "hashchange", renderRoute);
  listen(window, "scroll", updateDocsToc);

  renderRoute();
  setWalletState(wallet);
  return {
    getRoute,
    navigate(route, docSlug) { location.hash = route === "docs" && docSlug ? `#/docs/${docSlug}` : `#/${route === "home" ? "" : route}`; },
    renderRoute,
    setWalletState,
    setNetworkStatus(message, busy = false) {
      const status = byId("sync-status");
      status.textContent = message;
      status.classList.toggle("busy", busy);
      document.body.classList.toggle("busy", busy);
    },
    openDialog,
    closeDialog,
    showError,
    destroy() { for (const remove of removers) remove(); },
  };
}
