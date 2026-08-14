import type { Session, SupabaseClient } from "@supabase/supabase-js";

import { createReviewerAuthClient, getSessionDisplayName } from "./auth.js";
import { loadBrowserConfig } from "./browser-config.js";

const authPanel = requireElement<HTMLElement>(".auth-panel");
const statusMessage = requireElement<HTMLParagraphElement>("#auth-status");
const identity = requireElement<HTMLParagraphElement>("#auth-identity");
const signInButton = requireElement<HTMLButtonElement>("#sign-in");
const signOutButton = requireElement<HTMLButtonElement>("#sign-out");

let authClient: SupabaseClient | undefined;

function requireElement<ElementType extends Element>(selector: string) {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function renderSession(session: Session | null) {
  const displayName = getSessionDisplayName(session);
  const isSignedIn = displayName !== null;

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
}

function renderError(
  message: string,
  action: "sign-in" | "sign-out" = "sign-in",
) {
  authPanel.dataset.authState = "error";
  statusMessage.textContent = message;
  identity.hidden = true;
  signInButton.hidden = authClient === undefined || action !== "sign-in";
  signInButton.disabled = false;
  signOutButton.hidden = action !== "sign-out";
  signOutButton.disabled = false;
}

function clearOAuthParameters() {
  const url = new URL(window.location.href);
  const parameters = ["code", "error", "error_code", "error_description"];
  let changed = false;

  for (const parameter of parameters) {
    changed = url.searchParams.has(parameter) || changed;
    url.searchParams.delete(parameter);
  }

  if (changed) {
    window.history.replaceState(
      {},
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
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

signInButton.addEventListener("click", () => {
  void signIn();
});

signOutButton.addEventListener("click", () => {
  void signOut();
});

void initialize();
