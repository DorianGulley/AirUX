import type { AgentCredential, ReviewerReviewSummary } from "@airux/shared/v1";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import {
  type DashboardTab,
  getDashboardLandingPath,
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
import { listPendingReviewerReviews } from "./review-api.js";

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

  void listPendingReviewerReviews(session.access_token)
    .then((reviews) => {
      if (!isCurrent(sequence, session)) {
        return;
      }
      list.replaceChildren(...reviews.map(createReviewListItem));
      count.textContent = String(reviews.length);
      status.textContent = "";
      empty.hidden = reviews.length !== 0;
    })
    .catch(() => {
      if (!isCurrent(sequence, session)) {
        return;
      }
      count.textContent = "—";
      status.dataset.state = "error";
      status.textContent =
        "Your pending reviews couldn’t be loaded. Reload to try again.";
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
            .then(() => loadCredentials(`${selected.name} was revoked.`))
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
  const loadCredentials = async (successMessage = "") => {
    refreshButton.disabled = true;
    setStatus(successMessage === "" ? "Loading credentials…" : successMessage);
    try {
      const result = await listAgentCredentials(session.access_token);
      if (!isCurrent(sequence, session)) {
        return;
      }
      renderCredentials(result.credentials);
      setStatus(successMessage);
    } catch {
      if (isCurrent(sequence, session)) {
        setStatus(
          "Credentials are temporarily unavailable. Please try again.",
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
        await loadCredentials("Credential created.");
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
    void loadCredentials();
  });
  window.addEventListener("pagehide", clearSecret, { once: true });

  panel.append(formHeading, form, status, secret, listHeading, empty, list);
  main.append(panel);
  void loadCredentials();
  return main;
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
  const isRoot = window.location.pathname === "/";
  let activeTab: DashboardTab = route?.tab ?? "reviews";
  let authClient: SupabaseClient | undefined;
  let currentSession: Session | null = null;
  let renderSequence = 0;

  createLoadingPage(activeTab);

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

  const renderSession = (session: Session | null) => {
    currentSession = session;
    const sequence = ++renderSequence;
    if (isRoot && route === null) {
      const landingPath = getDashboardLandingPath(session !== null);
      window.history.replaceState({}, "", landingPath);
      route = matchDashboardRoute(landingPath);
      activeTab = route?.tab ?? "reviews";
    }
    if (!isRoot && route === null) {
      document.title = "Page unavailable | AirUX";
      renderAppPage(
        "reviews",
        getSessionDisplayName(session),
        createNotFoundPage(),
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
      renderAppPage(activeTab, null, createSignInState(activeTab, startSignIn));
      return;
    }

    const displayName = getSessionDisplayName(session) ?? "GitHub user";
    const isCurrent = (expectedSequence: number, expectedSession: Session) =>
      renderSequence === expectedSequence &&
      currentSession?.user.id === expectedSession.user.id;
    if (activeTab === "reviews") {
      document.title = "Reviews | AirUX";
      renderAppPage(
        activeTab,
        displayName,
        createReviewsPage(session, sequence, isCurrent),
      );
      return;
    }
    if (activeTab === "credentials") {
      document.title = "Credentials | AirUX";
      renderAppPage(
        activeTab,
        displayName,
        createCredentialsPage(session, sequence, isCurrent),
      );
      return;
    }

    document.title = "Account | AirUX";
    renderAppPage(
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
    );
  };

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
    renderAppPage(
      activeTab,
      null,
      createErrorPage(
        "Sign-in and private application data are temporarily unavailable.",
      ),
    );
  }
}
