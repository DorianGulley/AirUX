import type { AgentCredential, ReviewerReviewSummary } from "@airux/shared/v1";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import {
  type DashboardTab,
  getDashboardLandingPath,
  getDashboardNavigationPath,
  matchDashboardRoute,
} from "./app-route.js";
import { renderAppPage } from "./app-shell.js";
import {
  createReviewerAuthClient,
  getOAuthCallbackCleanupPath,
  getOAuthRedirectUrl,
  getSessionDisplayName,
} from "./auth.js";
import { loadBrowserConfig } from "./browser-config.js";
import {
  createAgentCredential,
  listAgentCredentials,
  revokeAgentCredential,
} from "./credential-api.js";
import { MemoryResourceCache } from "./memory-resource-cache.js";
import { listPendingReviewerReviews } from "./review-api.js";

const REVIEW_CACHE_TTL_MS = 30_000;
const CREDENTIAL_CACHE_TTL_MS = 60_000;

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

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function formatDuration(durationMs: number | null) {
  if (durationMs === null) {
    return "Duration unavailable";
  }
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0
    ? `${seconds} sec`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function createPageHeading(
  eyebrowText: string,
  titleText: string,
  descriptionText: string,
) {
  const heading = createElement("header", "dashboard-heading");
  const eyebrow = createElement("p", "eyebrow");
  eyebrow.textContent = eyebrowText;
  const title = createElement("h1", "dashboard-title");
  title.textContent = titleText;
  const description = createElement("p", "dashboard-description");
  description.textContent = descriptionText;
  heading.append(eyebrow, title, description);
  return heading;
}

function createDashboardMain() {
  const main = createElement("main", "dashboard-shell");
  main.id = "main-content";
  return main;
}

function createSignInState(
  tab: DashboardTab,
  onSignIn: (button: HTMLButtonElement, status: HTMLParagraphElement) => void,
) {
  const main = createDashboardMain();
  const copy =
    tab === "reviews"
      ? {
          eyebrow: "Interaction reviews",
          title: "Your review queue is private.",
          description:
            "Sign in to watch pending agent footage and send your decision.",
        }
      : tab === "credentials"
        ? {
            eyebrow: "Agent access",
            title: "Manage credentials securely.",
            description:
              "Sign in to create, view, and revoke access for your agent environments.",
          }
        : {
            eyebrow: "Account",
            title: "Sign in to AirUX.",
            description:
              "Use GitHub to access your private reviews and agent credentials.",
          };
  const card = createElement("section", "dashboard-auth-card");
  card.append(createPageHeading(copy.eyebrow, copy.title, copy.description));
  const button = createElement("button", "primary-action dashboard-sign-in");
  button.type = "button";
  button.textContent = "Continue with GitHub";
  const status = createElement("p", "dashboard-action-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const note = createElement("p", "dashboard-auth-note");
  note.textContent =
    "Use a trusted device. Your session stays in this browser until you sign out.";
  button.addEventListener("click", () => onSignIn(button, status));
  card.append(button, status, note);
  main.append(card);
  return main;
}

function createLoadingPage(tab: DashboardTab) {
  const main = createDashboardMain();
  main.setAttribute("aria-busy", "true");
  main.setAttribute("aria-label", "Loading AirUX");
  const card = createElement("section", "dashboard-loading-card");
  const eyebrow = createElement(
    "span",
    "review-skeleton review-skeleton-short",
  );
  const title = createElement("span", "review-skeleton review-skeleton-title");
  const line = createElement("span", "review-skeleton review-skeleton-line");
  card.append(eyebrow, title, line);
  main.append(card);
  renderAppPage(tab, null, main);
}

function createErrorPage(message: string) {
  const main = createDashboardMain();
  const card = createElement("section", "dashboard-auth-card");
  card.append(
    createPageHeading(
      "Temporarily unavailable",
      "AirUX couldn’t load.",
      message,
    ),
  );
  const retry = createElement("a", "review-home-action");
  retry.href = window.location.href;
  retry.textContent = "Try again";
  card.append(retry);
  main.append(card);
  return main;
}

function createNotFoundPage() {
  const main = createDashboardMain();
  const card = createElement("section", "dashboard-auth-card");
  card.append(
    createPageHeading(
      "Page unavailable",
      "That page doesn’t exist.",
      "Return to your review queue to continue.",
    ),
  );
  const link = createElement("a", "review-home-action");
  link.href = "/reviews";
  link.textContent = "Go to Reviews";
  card.append(link);
  main.append(card);
  return main;
}

function createReviewListItem(review: ReviewerReviewSummary) {
  const item = createElement("li", "review-inbox-item");
  const link = createElement("a", "review-inbox-link");
  link.href = `/reviews/${encodeURIComponent(review.id)}`;

  const copy = createElement("div", "review-inbox-copy");
  const state = createElement("span", "review-inbox-state");
  state.textContent = "Ready to review";
  const title = createElement("h2", "review-inbox-title");
  title.textContent = review.title;
  const metadata = createElement("p", "review-inbox-meta");
  const submitted = createElement("span");
  submitted.textContent = `Submitted ${formatTimestamp(review.submitted_at)}`;
  const duration = createElement("span");
  duration.textContent = formatDuration(review.evidence.duration_ms);
  const expires = createElement("span");
  expires.textContent = `Expires ${formatTimestamp(review.expires_at)}`;
  metadata.append(submitted, duration, expires);
  copy.append(state, title, metadata);

  const action = createElement("span", "review-inbox-action");
  const play = createElement("span", "review-inbox-play");
  play.textContent = "▶";
  play.setAttribute("aria-hidden", "true");
  const label = createElement("span");
  label.textContent = "Watch review";
  action.append(play, label);
  link.append(copy, action);
  item.append(link);
  return item;
}

function createReviewsPage(
  session: Session,
  sequence: number,
  isCurrent: (sequence: number, session: Session) => boolean,
  cache: MemoryResourceCache<ReviewerReviewSummary[]>,
) {
  const main = createDashboardMain();
  main.append(
    createPageHeading(
      "Interaction reviews",
      "Needs your review",
      "Watch focused agent footage, judge the stated claim, and resolve the work from any device.",
    ),
  );
  const panel = createElement("section", "review-inbox-panel");
  panel.setAttribute("aria-labelledby", "review-inbox-heading");
  const panelHeading = createElement("div", "review-inbox-heading");
  const title = createElement("h2");
  title.id = "review-inbox-heading";
  title.textContent = "Ready for playback";
  const count = createElement("span", "review-inbox-count");
  count.textContent = "…";
  panelHeading.append(title, count);
  const status = createElement("p", "review-inbox-status");
  status.textContent = "Loading pending reviews…";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const list = createElement("ul", "review-inbox-list");
  const empty = createElement("div", "review-inbox-empty");
  empty.hidden = true;
  const emptyTitle = createElement("h3");
  emptyTitle.textContent = "You’re all caught up.";
  const emptyCopy = createElement("p");
  emptyCopy.textContent =
    "New agent footage will appear here once it is processed and ready to watch.";
  empty.append(emptyTitle, emptyCopy);
  panel.append(panelHeading, status, list, empty);
  main.append(panel);

  const renderReviews = (reviews: ReviewerReviewSummary[]) => {
    list.replaceChildren(...reviews.map(createReviewListItem));
    count.textContent = String(reviews.length);
    status.textContent = "";
    status.removeAttribute("data-state");
    empty.hidden = reviews.length !== 0;
  };
  const cached = cache.read();
  if (cached !== null) {
    renderReviews(cached.value);
  }
  if (cached?.isFresh === true) {
    return main;
  }

  void cache
    .load(() => listPendingReviewerReviews(session.access_token))
    .then((reviews) => {
      if (reviews === undefined || !isCurrent(sequence, session)) {
        return;
      }
      renderReviews(reviews);
    })
    .catch(() => {
      if (!isCurrent(sequence, session)) {
        return;
      }
      status.dataset.state = "error";
      if (cached === null) {
        count.textContent = "—";
        status.textContent =
          "Your pending reviews couldn’t be loaded. Reload to try again.";
      } else {
        status.textContent =
          "Reviews couldn’t be refreshed. Showing your most recent results.";
      }
    });
  return main;
}

function createCredentialListItem(
  credential: AgentCredential,
  onRevoke: (credential: AgentCredential, button: HTMLButtonElement) => void,
) {
  const item = createElement("li", "credential-item");
  const details = createElement("div");
  const name = createElement("p", "credential-name");
  name.textContent = credential.name;
  const metadata = createElement("p", "credential-meta");
  const state = createElement("span", "credential-state");
  state.textContent = "Active";
  const created = createElement("span");
  created.textContent = `Created ${formatTimestamp(credential.created_at)}`;
  metadata.append(state, created);
  if (credential.last_used_at !== null) {
    const lastUsed = createElement("span");
    lastUsed.textContent = `Last used ${formatTimestamp(credential.last_used_at)}`;
    metadata.append(lastUsed);
  }
  details.append(name, metadata);

  const revokeButton = createElement("button", "danger-action");
  revokeButton.type = "button";
  revokeButton.textContent = "Revoke";
  revokeButton.setAttribute(
    "aria-label",
    `Revoke credential ${credential.name}`,
  );
  revokeButton.addEventListener("click", () =>
    onRevoke(credential, revokeButton),
  );
  item.append(details, revokeButton);
  return item;
}

function createCredentialsPage(
  session: Session,
  sequence: number,
  isCurrent: (sequence: number, session: Session) => boolean,
  cache: MemoryResourceCache<AgentCredential[]>,
) {
  const main = createDashboardMain();
  main.append(
    createPageHeading(
      "Agent access",
      "Agent credentials",
      "Create a separate credential for each agent environment, then revoke it when access is no longer needed.",
    ),
  );
  const panel = createElement("section", "credential-card");
  panel.setAttribute("aria-labelledby", "credential-create-title");
  const formHeading = createElement("div", "credential-section-heading");
  const formTitle = createElement("h2");
  formTitle.id = "credential-create-title";
  formTitle.textContent = "Create credential";
  const formCopy = createElement("p");
  formCopy.textContent =
    "The secret is shown once. Save it directly in the matching agent environment.";
  formHeading.append(formTitle, formCopy);

  const form = createElement("form", "credential-form");
  const label = createElement("label");
  label.htmlFor = "credential-name";
  label.textContent = "Credential name";
  const row = createElement("div", "form-row");
  const nameInput = createElement("input");
  nameInput.id = "credential-name";
  nameInput.name = "name";
  nameInput.type = "text";
  nameInput.maxLength = 200;
  nameInput.autocomplete = "off";
  nameInput.placeholder = "Codex on laptop";
  nameInput.required = true;
  const createButton = createElement("button", "primary-action");
  createButton.type = "submit";
  createButton.textContent = "Create credential";
  row.append(nameInput, createButton);
  form.append(label, row);

  const status = createElement("p", "credential-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    status.dataset.state = isError ? "error" : "ready";
  };

  const secret = createElement("aside", "credential-secret");
  secret.hidden = true;
  const warning = createElement("p", "secret-warning");
  warning.textContent = "Copy this credential now. AirUX cannot show it again.";
  const token = createElement("code");
  const secretActions = createElement("div", "secret-actions");
  const copyButton = createElement("button", "primary-action");
  copyButton.type = "button";
  copyButton.textContent = "Copy credential";
  const dismissButton = createElement("button", "secondary-action");
  dismissButton.type = "button";
  dismissButton.textContent = "I have saved it";
  secretActions.append(copyButton, dismissButton);
  secret.append(warning, token, secretActions);

  const listHeading = createElement("div", "credential-list-heading");
  const listTitle = createElement("h2");
  listTitle.textContent = "Active credentials";
  const refreshButton = createElement("button", "text-action");
  refreshButton.type = "button";
  refreshButton.textContent = "Refresh";
  listHeading.append(listTitle, refreshButton);
  const empty = createElement("p", "empty-state");
  empty.hidden = true;
  empty.textContent = "No active agent credentials.";
  const list = createElement("ul", "credential-list");

  const clearSecret = () => {
    token.textContent = "";
    secret.hidden = true;
    copyButton.disabled = false;
    nameInput.disabled = false;
    createButton.disabled = false;
  };
  const renderCredentials = (credentials: AgentCredential[]) => {
    const active = credentials.filter(
      (credential) => credential.revoked_at === null,
    );
    list.replaceChildren(
      ...active.map((credential) =>
        createCredentialListItem(credential, (selected, button) => {
          button.disabled = true;
          setStatus(`Revoking ${selected.name}…`);
          void revokeAgentCredential(selected.id, session.access_token)
            .then(() => {
              cache.clear();
              return loadCredentials(`${selected.name} was revoked.`, true);
            })
            .catch(() => {
              if (!isCurrent(sequence, session)) {
                return;
              }
              button.disabled = false;
              setStatus(
                "The credential could not be revoked. Please try again.",
                true,
              );
            });
        }),
      ),
    );
    empty.hidden = active.length !== 0;
  };
  const loadCredentials = async (successMessage = "", force = false) => {
    const cached = cache.read();
    if (cached !== null) {
      renderCredentials(cached.value);
    }
    if (!force && cached?.isFresh === true) {
      setStatus(successMessage);
      return;
    }

    refreshButton.disabled = true;
    if (cached === null || force) {
      setStatus(
        successMessage === "" ? "Loading credentials…" : successMessage,
      );
    } else {
      setStatus(successMessage);
    }
    try {
      const credentials = await cache.load(async () => {
        const result = await listAgentCredentials(session.access_token);
        return result.credentials;
      });
      if (credentials === undefined || !isCurrent(sequence, session)) {
        return;
      }
      renderCredentials(credentials);
      setStatus(successMessage);
    } catch {
      if (isCurrent(sequence, session)) {
        setStatus(
          cached === null
            ? "Credentials are temporarily unavailable. Please try again."
            : "Credentials couldn’t be refreshed. Showing your most recent results.",
          true,
        );
      }
    } finally {
      if (isCurrent(sequence, session)) {
        refreshButton.disabled = false;
      }
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!secret.hidden) {
      return;
    }
    createButton.disabled = true;
    nameInput.disabled = true;
    setStatus("Creating credential…");
    void createAgentCredential(nameInput.value, session.access_token)
      .then(async (result) => {
        if (!isCurrent(sequence, session)) {
          return;
        }
        form.reset();
        token.textContent = result.token;
        secret.hidden = false;
        copyButton.focus();
        setStatus("Credential created.");
        cache.clear();
        await loadCredentials("Credential created.", true);
      })
      .catch(() => {
        if (!isCurrent(sequence, session)) {
          return;
        }
        clearSecret();
        setStatus(
          "The credential could not be created. Check its name and try again.",
          true,
        );
      });
  });
  copyButton.addEventListener("click", () => {
    const value = token.textContent;
    if (value === "") {
      return;
    }
    copyButton.disabled = true;
    void navigator.clipboard
      .writeText(value)
      .then(() =>
        setStatus("Credential copied. Store it securely before dismissing."),
      )
      .catch(() =>
        setStatus(
          "Copy failed. Select the credential text and copy it manually.",
          true,
        ),
      )
      .finally(() => {
        copyButton.disabled = false;
      });
  });
  dismissButton.addEventListener("click", () => {
    clearSecret();
    setStatus("Credential hidden. It cannot be shown again.");
    nameInput.focus();
  });
  refreshButton.addEventListener("click", () => {
    void loadCredentials("", true);
  });
  const handlePageHide = () => clearSecret();
  window.addEventListener("pagehide", handlePageHide);

  panel.append(formHeading, form, status, secret, listHeading, empty, list);
  main.append(panel);
  void loadCredentials();
  return {
    element: main,
    cleanup: () => {
      clearSecret();
      window.removeEventListener("pagehide", handlePageHide);
    },
  };
}

function createAccountPage(
  session: Session,
  onSignOut: (button: HTMLButtonElement, status: HTMLParagraphElement) => void,
) {
  const main = createDashboardMain();
  const card = createElement("section", "account-card");
  card.append(
    createPageHeading(
      "Account",
      "Signed in and ready.",
      "Your GitHub identity protects private review footage and credential management.",
    ),
  );
  const identityPanel = createElement("div", "account-identity");
  const label = createElement("p", "account-identity-label");
  label.textContent = "Signed in as";
  const name = createElement("p", "account-identity-name");
  name.textContent = getSessionDisplayName(session) ?? "GitHub user";
  identityPanel.append(label, name);
  const signOutButton = createElement("button", "secondary-action");
  signOutButton.type = "button";
  signOutButton.textContent = "Sign out";
  const status = createElement("p", "dashboard-action-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  signOutButton.addEventListener("click", () =>
    onSignOut(signOutButton, status),
  );
  card.append(identityPanel, signOutButton, status);
  main.append(card);
  return main;
}

function clearOAuthParameters() {
  const cleanPath = getOAuthCallbackCleanupPath(window.location.href);
  if (cleanPath !== null) {
    window.history.replaceState({}, "", cleanPath);
  }
}

export async function initializeDashboardPage() {
  let route = matchDashboardRoute(window.location.pathname);
  let needsLandingResolution = window.location.pathname === "/";
  let activeTab: DashboardTab = route?.tab ?? "reviews";
  let authClient: SupabaseClient | undefined;
  let currentSession: Session | null = null;
  let renderSequence = 0;
  let cacheOwnerId: string | null = null;
  let activePageCleanup: (() => void) | undefined;
  const reviewsCache = new MemoryResourceCache<ReviewerReviewSummary[]>(
    REVIEW_CACHE_TTL_MS,
  );
  const credentialsCache = new MemoryResourceCache<AgentCredential[]>(
    CREDENTIAL_CACHE_TTL_MS,
  );

  createLoadingPage(activeTab);

  const renderDashboardPage = (
    tab: DashboardTab,
    displayName: string | null,
    content: HTMLElement,
    focusContent = false,
    cleanup?: () => void,
  ) => {
    activePageCleanup?.();
    activePageCleanup = cleanup;
    renderAppPage(tab, displayName, content);
    if (focusContent) {
      const focusTarget = content.querySelector<HTMLElement>("h1") ?? content;
      focusTarget.tabIndex = -1;
      focusTarget.focus({ preventScroll: true });
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
  };

  const alignCacheOwner = (session: Session | null) => {
    const userId = session?.user.id ?? null;
    if (userId === cacheOwnerId) {
      return;
    }
    reviewsCache.clear();
    credentialsCache.clear();
    cacheOwnerId = userId;
  };

  const startSignIn = (
    button: HTMLButtonElement,
    status: HTMLParagraphElement,
  ) => {
    if (authClient === undefined) {
      return;
    }
    button.disabled = true;
    status.textContent = "Redirecting to GitHub…";
    void authClient.auth
      .signInWithOAuth({
        provider: "github",
        options: { redirectTo: getOAuthRedirectUrl(window.location.href) },
      })
      .then(({ error }) => {
        if (error !== null) {
          throw error;
        }
      })
      .catch(() => {
        button.disabled = false;
        status.textContent =
          "GitHub sign-in could not be started. Please try again.";
      });
  };

  const renderSession = (session: Session | null, focusContent = false) => {
    currentSession = session;
    alignCacheOwner(session);
    const sequence = ++renderSequence;
    if (needsLandingResolution) {
      const landingPath = getDashboardLandingPath(session !== null);
      window.history.replaceState({}, "", landingPath);
      route = matchDashboardRoute(landingPath);
      activeTab = route?.tab ?? "reviews";
      needsLandingResolution = false;
    }
    if (route === null) {
      document.title = "Page unavailable | AirUX";
      renderDashboardPage(
        "reviews",
        getSessionDisplayName(session),
        createNotFoundPage(),
        focusContent,
      );
      return;
    }
    activeTab = route?.tab ?? activeTab;
    if (session === null) {
      const title =
        activeTab === "account"
          ? "Sign in"
          : `${activeTab[0]?.toUpperCase()}${activeTab.slice(1)}`;
      document.title = `${title} | AirUX`;
      renderDashboardPage(
        activeTab,
        null,
        createSignInState(activeTab, startSignIn),
        focusContent,
      );
      return;
    }

    const displayName = getSessionDisplayName(session) ?? "GitHub user";
    const isCurrent = (expectedSequence: number, expectedSession: Session) =>
      renderSequence === expectedSequence &&
      currentSession?.user.id === expectedSession.user.id;
    if (activeTab === "reviews") {
      document.title = "Reviews | AirUX";
      renderDashboardPage(
        activeTab,
        displayName,
        createReviewsPage(session, sequence, isCurrent, reviewsCache),
        focusContent,
      );
      return;
    }
    if (activeTab === "credentials") {
      document.title = "Credentials | AirUX";
      const page = createCredentialsPage(
        session,
        sequence,
        isCurrent,
        credentialsCache,
      );
      renderDashboardPage(
        activeTab,
        displayName,
        page.element,
        focusContent,
        page.cleanup,
      );
      return;
    }

    document.title = "Account | AirUX";
    renderDashboardPage(
      activeTab,
      displayName,
      createAccountPage(session, (button, status) => {
        if (authClient === undefined) {
          return;
        }
        button.disabled = true;
        status.textContent = "Signing out…";
        void authClient.auth
          .signOut({ scope: "local" })
          .then(({ error }) => {
            if (error !== null) {
              throw error;
            }
            renderSession(null);
          })
          .catch(() => {
            button.disabled = false;
            status.textContent = "Sign-out failed. Please try again.";
          });
      }),
      focusContent,
    );
  };

  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    ) {
      return;
    }
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (
      link === null ||
      link.hasAttribute("download") ||
      (link.target !== "" && link.target !== "_self")
    ) {
      return;
    }
    const path = getDashboardNavigationPath(link.href, window.location.origin);
    if (path === null) {
      return;
    }
    event.preventDefault();
    if (
      window.location.pathname === path &&
      window.location.search === "" &&
      window.location.hash === ""
    ) {
      return;
    }
    window.history.pushState({}, "", path);
    route = matchDashboardRoute(path);
    activeTab = route?.tab ?? activeTab;
    renderSession(currentSession, true);
  });

  window.addEventListener("popstate", () => {
    needsLandingResolution = window.location.pathname === "/";
    route = matchDashboardRoute(window.location.pathname);
    activeTab = route?.tab ?? activeTab;
    renderSession(currentSession, true);
  });

  try {
    const config = await loadBrowserConfig();
    authClient = createReviewerAuthClient(config, window.localStorage);
    const { data, error } = await authClient.auth.getSession();
    clearOAuthParameters();
    if (error !== null) {
      throw error;
    }
    authClient.auth.onAuthStateChange((_event, session) => {
      renderSession(session);
    });
    renderSession(data.session);
  } catch {
    clearOAuthParameters();
    document.title = "AirUX unavailable";
    renderDashboardPage(
      activeTab,
      null,
      createErrorPage(
        "Sign-in and private application data are temporarily unavailable.",
      ),
    );
  }
}
