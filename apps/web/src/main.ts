import type { AgentCredential } from "@airux/shared/v1";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import {
  createReviewerAuthClient,
  getOAuthCallbackCleanupPath,
  getSessionDisplayName,
} from "./auth.js";
import { loadBrowserConfig } from "./browser-config.js";
import {
  createAgentCredential,
  listAgentCredentials,
  revokeAgentCredential,
} from "./credential-api.js";

const authPanel = requireElement<HTMLElement>(".auth-panel");
const authCard = requireElement<HTMLElement>(".auth-card");
const statusMessage = requireElement<HTMLParagraphElement>("#auth-status");
const identity = requireElement<HTMLParagraphElement>("#auth-identity");
const signInButton = requireElement<HTMLButtonElement>("#sign-in");
const signOutButton = requireElement<HTMLButtonElement>("#sign-out");
const credentialManager = requireElement<HTMLElement>("#credential-manager");
const credentialForm = requireElement<HTMLFormElement>("#credential-form");
const credentialName = requireElement<HTMLInputElement>("#credential-name");
const createCredentialButton =
  requireElement<HTMLButtonElement>("#create-credential");
const credentialStatus =
  requireElement<HTMLParagraphElement>("#credential-status");
const credentialSecret = requireElement<HTMLElement>("#credential-secret");
const credentialToken = requireElement<HTMLElement>("#credential-token");
const copyCredentialButton =
  requireElement<HTMLButtonElement>("#copy-credential");
const dismissCredentialButton = requireElement<HTMLButtonElement>(
  "#dismiss-credential",
);
const refreshCredentialsButton = requireElement<HTMLButtonElement>(
  "#refresh-credentials",
);
const credentialEmpty =
  requireElement<HTMLParagraphElement>("#credential-empty");
const credentialList = requireElement<HTMLUListElement>("#credential-list");

let authClient: SupabaseClient | undefined;
let currentSession: Session | null = null;
let currentUserId: string | null = null;
let credentialLoadSequence = 0;

function requireElement<ElementType extends Element>(selector: string) {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function setCredentialStatus(message: string, isError = false) {
  credentialStatus.textContent = message;
  credentialStatus.dataset.state = isError ? "error" : "ready";
}

function clearCredentialSecret() {
  credentialToken.textContent = "";
  credentialSecret.hidden = true;
  copyCredentialButton.disabled = false;
  credentialName.disabled = false;
  createCredentialButton.disabled = false;
}

function showCredentialSecret(token: string) {
  credentialToken.textContent = token;
  credentialSecret.hidden = false;
  credentialName.disabled = true;
  createCredentialButton.disabled = true;
  copyCredentialButton.focus();
}

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function createCredentialListItem(credential: AgentCredential) {
  const item = document.createElement("li");
  item.className = "credential-item";

  const details = document.createElement("div");
  const name = document.createElement("p");
  name.className = "credential-name";
  name.textContent = credential.name;
  details.append(name);

  const metadata = document.createElement("p");
  metadata.className = "credential-meta";
  const state = document.createElement("span");
  const revoked = credential.revoked_at !== null;
  state.className = "credential-state";
  state.dataset.revoked = String(revoked);
  state.textContent = revoked ? "Revoked" : "Active";
  metadata.append(state);

  const created = document.createElement("span");
  created.textContent = `Created ${formatTimestamp(credential.created_at)}`;
  metadata.append(created);

  if (credential.last_used_at !== null) {
    const lastUsed = document.createElement("span");
    lastUsed.textContent = `Last used ${formatTimestamp(credential.last_used_at)}`;
    metadata.append(lastUsed);
  }
  details.append(metadata);
  item.append(details);

  if (!revoked) {
    const revokeButton = document.createElement("button");
    revokeButton.className = "danger-action";
    revokeButton.type = "button";
    revokeButton.textContent = "Revoke";
    revokeButton.setAttribute(
      "aria-label",
      `Revoke credential ${credential.name}`,
    );
    revokeButton.addEventListener("click", () => {
      void revokeCredentialFromPage(credential, revokeButton);
    });
    item.append(revokeButton);
  }

  return item;
}

function renderCredentialList(credentials: AgentCredential[]) {
  credentialList.replaceChildren(...credentials.map(createCredentialListItem));
  credentialEmpty.hidden = credentials.length !== 0;
}

async function refreshCredentials() {
  const session = currentSession;
  if (session === null) {
    return;
  }

  const sequence = ++credentialLoadSequence;
  refreshCredentialsButton.disabled = true;
  setCredentialStatus("Loading credentials…");

  try {
    const result = await listAgentCredentials(session.access_token);
    if (
      sequence !== credentialLoadSequence ||
      currentSession?.user.id !== session.user.id
    ) {
      return;
    }
    renderCredentialList(result.credentials);
    setCredentialStatus("");
  } catch {
    if (sequence === credentialLoadSequence) {
      setCredentialStatus(
        "Credentials are temporarily unavailable. Please try again.",
        true,
      );
    }
  } finally {
    if (sequence === credentialLoadSequence) {
      refreshCredentialsButton.disabled = false;
    }
  }
}

function renderSession(session: Session | null) {
  const displayName = getSessionDisplayName(session);
  const isSignedIn = displayName !== null;
  const nextUserId = session?.user.id ?? null;
  const userChanged = nextUserId !== currentUserId;

  currentSession = session;
  currentUserId = nextUserId;
  authCard.dataset.authState = isSignedIn ? "signed-in" : "signed-out";
  authPanel.dataset.authState = isSignedIn ? "signed-in" : "signed-out";
  statusMessage.textContent = isSignedIn
    ? "You are ready to review."
    : "Sign in to continue.";
  identity.textContent = isSignedIn ? `Signed in as ${displayName}` : "";
  identity.hidden = !isSignedIn;
  signInButton.hidden = isSignedIn;
  signOutButton.hidden = !isSignedIn;
  signInButton.disabled = false;
  signOutButton.disabled = false;
  credentialManager.hidden = !isSignedIn;

  if (userChanged) {
    credentialLoadSequence += 1;
    clearCredentialSecret();
    renderCredentialList([]);
    setCredentialStatus("");
  }

  if (session !== null && userChanged) {
    void refreshCredentials();
  }
}

function renderError(
  message: string,
  action: "sign-in" | "sign-out" = "sign-in",
) {
  credentialLoadSequence += 1;
  currentSession = null;
  currentUserId = null;
  clearCredentialSecret();
  credentialManager.hidden = true;
  authCard.dataset.authState = "error";
  authPanel.dataset.authState = "error";
  statusMessage.textContent = message;
  identity.hidden = true;
  signInButton.hidden = authClient === undefined || action !== "sign-in";
  signInButton.disabled = false;
  signOutButton.hidden = action !== "sign-out";
  signOutButton.disabled = false;
}

function clearOAuthParameters() {
  const cleanPath = getOAuthCallbackCleanupPath(window.location.href);
  if (cleanPath !== null) {
    window.history.replaceState({}, "", cleanPath);
  }
}

async function initialize() {
  try {
    const config = await loadBrowserConfig();
    authClient = createReviewerAuthClient(config, window.localStorage);

    const { data, error } = await authClient.auth.getSession();
    clearOAuthParameters();
    if (error !== null) {
      renderError("We could not restore your session. Please sign in again.");
      return;
    }

    renderSession(data.session);
    authClient.auth.onAuthStateChange((_event, session) => {
      renderSession(session);
    });
  } catch {
    clearOAuthParameters();
    renderError("Sign-in is temporarily unavailable. Please try again.");
  }
}

async function signIn() {
  if (authClient === undefined) {
    return;
  }

  try {
    signInButton.disabled = true;
    statusMessage.textContent = "Redirecting to GitHub…";
    const { error } = await authClient.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: `${window.location.origin}/` },
    });

    if (error === null) {
      return;
    }
  } catch {
    // Authentication failures are intentionally rendered without provider details.
  }

  renderError("GitHub sign-in could not be started. Please try again.");
}

async function signOut() {
  if (authClient === undefined) {
    return;
  }

  clearCredentialSecret();
  try {
    signOutButton.disabled = true;
    statusMessage.textContent = "Signing out…";
    const { error } = await authClient.auth.signOut({ scope: "local" });

    if (error === null) {
      return;
    }
  } catch {
    // Authentication failures are intentionally rendered without provider details.
  }

  renderError("Sign-out failed. Please try again.", "sign-out");
}

async function createCredentialFromPage() {
  const session = currentSession;
  if (session === null || !credentialSecret.hidden) {
    return;
  }

  createCredentialButton.disabled = true;
  credentialName.disabled = true;
  setCredentialStatus("Creating credential…");
  try {
    const result = await createAgentCredential(
      credentialName.value,
      session.access_token,
    );
    if (currentSession?.user.id !== session.user.id) {
      return;
    }
    credentialForm.reset();
    showCredentialSecret(result.token);
    setCredentialStatus("Credential created.");
    await refreshCredentials();
  } catch {
    setCredentialStatus(
      "The credential could not be created. Check its name and try again.",
      true,
    );
  } finally {
    if (credentialSecret.hidden) {
      createCredentialButton.disabled = false;
      credentialName.disabled = false;
    }
  }
}

async function copyCredentialFromPage() {
  const token = credentialToken.textContent;
  if (token === "") {
    return;
  }

  copyCredentialButton.disabled = true;
  try {
    await navigator.clipboard.writeText(token);
    setCredentialStatus(
      "Credential copied. Store it securely before dismissing.",
    );
  } catch {
    setCredentialStatus(
      "Copy failed. Select the credential text and copy it manually.",
      true,
    );
  } finally {
    copyCredentialButton.disabled = false;
  }
}

async function revokeCredentialFromPage(
  credential: AgentCredential,
  button: HTMLButtonElement,
) {
  const session = currentSession;
  if (session === null) {
    return;
  }

  button.disabled = true;
  setCredentialStatus(`Revoking ${credential.name}…`);
  try {
    await revokeAgentCredential(credential.id, session.access_token);
    if (currentSession?.user.id !== session.user.id) {
      return;
    }
    await refreshCredentials();
    setCredentialStatus(`${credential.name} was revoked.`);
  } catch {
    button.disabled = false;
    setCredentialStatus(
      "The credential could not be revoked. Please try again.",
      true,
    );
  }
}

signInButton.addEventListener("click", () => {
  void signIn();
});

signOutButton.addEventListener("click", () => {
  void signOut();
});

credentialForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void createCredentialFromPage();
});

copyCredentialButton.addEventListener("click", () => {
  void copyCredentialFromPage();
});

dismissCredentialButton.addEventListener("click", () => {
  clearCredentialSecret();
  setCredentialStatus("Credential hidden. It cannot be shown again.");
  credentialName.focus();
});

refreshCredentialsButton.addEventListener("click", () => {
  void refreshCredentials();
});

window.addEventListener("pagehide", () => {
  clearCredentialSecret();
});

void initialize();
