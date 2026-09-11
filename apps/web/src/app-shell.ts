import type { DashboardTab } from "./app-route.js";

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
) {
  const element = document.createElement(tagName);
  if (className !== undefined) {
    element.className = className;
  }
  return element;
}

const TABS = [
  { id: "reviews", label: "Reviews", href: "/reviews" },
  { id: "credentials", label: "Credentials", href: "/credentials" },
  { id: "account", label: "Account", href: "/account" },
] as const;

export function createAppHeader(
  activeTab: DashboardTab,
  displayName: string | null,
) {
  const header = createElement("header", "app-site-header");
  const inner = createElement("div", "app-site-header-inner");
  const homeLink = createElement("a", "app-wordmark");
  homeLink.href = "/reviews";
  homeLink.textContent = "AirUX";
  homeLink.setAttribute("aria-label", "AirUX reviews");

  const nav = createElement("nav", "app-tabs");
  nav.setAttribute("aria-label", "Primary");
  for (const tab of TABS) {
    const link = createElement("a", "app-tab");
    link.href = tab.href;
    link.textContent = tab.label;
    if (tab.id === activeTab) {
      link.setAttribute("aria-current", "page");
    }
    nav.append(link);
  }

  const account = createElement("div", "app-header-account");
  if (displayName === null) {
    const signInLink = createElement("a", "app-account-link");
    signInLink.href = "/account";
    signInLink.textContent = "Sign in";
    account.append(signInLink);
  } else {
    const identity = createElement("span", "app-account-name");
    identity.textContent = displayName;
    account.append(identity);
  }

  inner.append(homeLink, nav, account);
  header.append(inner);
  return header;
}

export function renderAppPage(
  activeTab: DashboardTab,
  displayName: string | null,
  content: HTMLElement,
) {
  document.body.className = "app-body";
  document.body.replaceChildren(
    createAppHeader(activeTab, displayName),
    content,
  );
}
