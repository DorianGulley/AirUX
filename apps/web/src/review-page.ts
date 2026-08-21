import type {
  DecisionRequest,
  ReviewerReview,
  StreamPlayback,
} from "@airux/shared/v1";
import { CONTRACT_LIMITS } from "@airux/shared/v1/limits";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import {
  createReviewerAuthClient,
  getOAuthCallbackCleanupPath,
  getSessionDisplayName,
} from "./auth.js";
import { loadBrowserConfig } from "./browser-config.js";
import {
  createReviewPlayback,
  getReviewerReview,
  ReviewApiError,
  submitReviewDecision,
} from "./review-api.js";
import {
  observeReviewSession,
  restoreReviewSession,
  signInToReview,
  signOutFromReview,
} from "./review-auth.js";
import {
  decideReviewFixture,
  getReviewFixtureMode,
  loadReviewFixture,
} from "./review-fixture.js";
import { getReviewStatusLabel } from "./review-presentation.js";
import type { ReviewRoute } from "./review-route.js";

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

interface ReviewHeaderAccount {
  readonly displayName: string;
  readonly onSignOut: (
    button: HTMLButtonElement,
    status: HTMLParagraphElement,
  ) => void;
}

function createBrandHeader(account?: ReviewHeaderAccount) {
  const header = createElement("header", "review-site-header");
  const homeLink = createElement("a", "review-wordmark");
  homeLink.href = "/";
  homeLink.textContent = "AirUX";
  homeLink.setAttribute("aria-label", "AirUX home");

  if (account === undefined) {
    const context = createElement("p", "review-site-context");
    context.textContent = "Human review";
    header.append(homeLink, context);
    return header;
  }

  const accountPanel = createElement("div", "review-account");
  const identity = createElement("p", "review-account-name");
  identity.textContent = account.displayName;
  const signOutButton = createElement("button", "review-sign-out");
  signOutButton.type = "button";
  signOutButton.textContent = "Sign out";
  const status = createElement("p", "review-account-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  signOutButton.addEventListener("click", () => {
    account.onSignOut(signOutButton, status);
  });
  accountPanel.append(identity, signOutButton, status);
  header.append(homeLink, accountPanel);
  return header;
}

function createLoadingState() {
  const main = createElement("main", "review-state-shell review-loading");
  main.dataset.reviewState = "loading";
  main.setAttribute("aria-busy", "true");
  main.setAttribute("aria-label", "Loading review");

  const heading = createElement("div", "review-loading-heading");
  const eyebrow = createElement(
    "span",
    "review-skeleton review-skeleton-short",
  );
  const title = createElement("span", "review-skeleton review-skeleton-title");
  heading.append(eyebrow, title);

  const layout = createElement("div", "review-layout");
  const evidence = createElement(
    "section",
    "review-panel review-evidence-panel",
  );
  const evidenceLabel = createElement(
    "span",
    "review-skeleton review-skeleton-label",
  );
  const evidenceFrame = createElement(
    "div",
    "review-skeleton review-skeleton-video",
  );
  evidence.append(evidenceLabel, evidenceFrame);

  const details = createElement("aside", "review-panel review-detail-panel");
  for (const className of [
    "review-skeleton-label",
    "review-skeleton-line",
    "review-skeleton-line",
    "review-skeleton-line-short",
  ]) {
    details.append(createElement("span", `review-skeleton ${className}`));
  }

  layout.append(evidence, details);
  main.append(heading, layout);
  return main;
}

type DecisionSubmitter = (decision: DecisionRequest) => Promise<void>;

function createDecisionSection(
  review: ReviewerReview,
  onDecision: DecisionSubmitter,
) {
  const section = createElement("section", "review-decision");
  section.setAttribute("aria-labelledby", "decision-title");
  const title = createElement("h2");
  title.id = "decision-title";
  title.textContent = "Your decision";
  section.append(title);

  if (review.decision !== null) {
    const result = createElement("div", "review-decision-result");
    const outcome = createElement("p", "review-decision-outcome");
    outcome.textContent =
      review.decision.outcome === "approved"
        ? "You approved this review."
        : "You requested changes.";
    result.append(outcome);
    if (review.decision.comment !== null) {
      const commentLabel = createElement("p", "review-decision-comment-label");
      commentLabel.textContent = "Feedback sent";
      const comment = createElement("p", "review-decision-comment");
      comment.textContent = review.decision.comment;
      result.append(commentLabel, comment);
    }
    const recorded = createElement("p", "review-decision-hint");
    recorded.textContent =
      "This decision is final and has been sent to the agent.";
    result.append(recorded);
    section.append(result);
    return section;
  }

  if (review.status !== "pending") {
    const unavailable = createElement("p", "review-decision-hint");
    unavailable.textContent =
      review.status === "draft"
        ? "This review is not ready for a decision yet."
        : "This review no longer accepts decisions.";
    section.append(unavailable);
    return section;
  }

  const form = createElement("form", "review-decision-form");
  const label = createElement("label", "review-comment-label");
  label.htmlFor = "decision-comment";
  label.textContent = "Feedback";
  const optional = createElement("span");
  optional.textContent = "Optional for approval";
  label.append(optional);
  const comment = createElement("textarea", "review-comment-input");
  comment.id = "decision-comment";
  comment.name = "comment";
  comment.rows = 4;
  comment.maxLength = CONTRACT_LIMITS.commentLength;
  comment.placeholder = "What should the agent correct or show next?";
  const hint = createElement("p", "review-decision-hint");
  hint.id = "decision-hint";
  hint.textContent = "Feedback is required when requesting changes.";
  comment.setAttribute("aria-describedby", hint.id);

  const actions = createElement("div", "review-decision-actions");
  const approveButton = createElement(
    "button",
    "review-decision-button review-approve-action",
  );
  approveButton.type = "button";
  approveButton.textContent = "Approve";
  const requestChangesButton = createElement(
    "button",
    "review-decision-button review-changes-action",
  );
  requestChangesButton.type = "button";
  requestChangesButton.textContent = "Request changes";
  actions.append(approveButton, requestChangesButton);

  const status = createElement("p", "review-decision-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  let submitting = false;
  const submit = async (outcome: DecisionRequest["outcome"]) => {
    if (submitting) {
      return;
    }
    const feedback = comment.value.trim();
    if (outcome === "changes_requested" && feedback.length === 0) {
      comment.setAttribute("aria-invalid", "true");
      status.textContent = "Add feedback before requesting changes.";
      comment.focus();
      return;
    }

    submitting = true;
    comment.removeAttribute("aria-invalid");
    comment.disabled = true;
    approveButton.disabled = true;
    requestChangesButton.disabled = true;
    status.textContent =
      outcome === "approved" ? "Submitting approval…" : "Sending feedback…";
    try {
      await onDecision({
        expected_version: review.version,
        outcome,
        ...(feedback.length === 0 ? {} : { comment: feedback }),
      });
    } catch {
      submitting = false;
      comment.disabled = false;
      approveButton.disabled = false;
      requestChangesButton.disabled = false;
      status.textContent =
        "Your decision could not be submitted. Please try again.";
    }
  };

  approveButton.addEventListener("click", () => {
    void submit("approved");
  });
  requestChangesButton.addEventListener("click", () => {
    void submit("changes_requested");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
  });
  form.append(label, comment, hint, actions, status);
  section.append(form);
  return section;
}

function createReviewDetails(
  review: ReviewerReview,
  onDecision: DecisionSubmitter,
) {
  const details = createElement("aside", "review-panel review-detail-panel");
  details.setAttribute("aria-label", "Review details and decision");

  const statusRow = createElement("div", "review-status-row");
  const statusLabel = createElement("span", "review-status-label");
  statusLabel.textContent = "Review status";
  const status = createElement("span", "review-status");
  status.dataset.status = review.status;
  status.textContent = getReviewStatusLabel(review.status);
  statusRow.append(statusLabel, status);

  const claim = createElement("section", "review-detail-section");
  claim.setAttribute("aria-labelledby", "claim-title");
  const claimTitle = createElement("h2");
  claimTitle.id = "claim-title";
  claimTitle.textContent = "Agent’s claim";
  const claimCopy = createElement("p", "review-claim");
  claimCopy.textContent = review.claim;
  claim.append(claimTitle, claimCopy);

  const criteria = createElement("section", "review-detail-section");
  criteria.setAttribute("aria-labelledby", "criteria-title");
  const criteriaTitle = createElement("h2");
  criteriaTitle.id = "criteria-title";
  criteriaTitle.textContent = "What to check";
  const criteriaList = createElement("ol", "review-criteria");
  for (const criterion of review.criteria) {
    const item = createElement("li");
    item.textContent = criterion.prompt;
    criteriaList.append(item);
  }
  criteria.append(criteriaTitle, criteriaList);

  const boundary = createElement("p", "review-boundary");
  boundary.textContent =
    "Approval applies only to this claim and the evidence shown.";

  details.append(
    statusRow,
    claim,
    criteria,
    boundary,
    createDecisionSection(review, onDecision),
  );
  return details;
}

function createPlaybackFrame(
  review: ReviewerReview,
  playback: StreamPlayback | "unavailable" | null,
) {
  const evidenceFrame = createElement("div", "review-video-shell");
  const browserBar = createElement("div", "review-browser-bar");
  browserBar.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    browserBar.append(createElement("span"));
  }

  if (typeof playback === "object" && playback !== null) {
    const player = createElement("iframe", "review-stream-player");
    player.src = playback.player_url;
    player.title = `Video evidence for ${review.title}`;
    player.allow =
      "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture";
    player.allowFullscreen = true;
    player.referrerPolicy = "no-referrer";
    evidenceFrame.append(browserBar, player);
    return evidenceFrame;
  }

  const evidencePlaceholder = createElement("div", "review-video-placeholder");
  const playMark = createElement("span", "review-play-mark");
  playMark.textContent = playback === "unavailable" ? "!" : "▶";
  playMark.setAttribute("aria-hidden", "true");
  const placeholderText = createElement("p");
  if (playback === "unavailable") {
    placeholderText.textContent =
      "Private playback is temporarily unavailable. Reload to try again.";
  } else if (review.evidence.status !== "ready") {
    placeholderText.textContent = "Video evidence is not ready for playback.";
  } else {
    placeholderText.textContent = "Private playback will appear here";
  }
  evidencePlaceholder.append(playMark, placeholderText);
  evidenceFrame.append(browserBar, evidencePlaceholder);
  return evidenceFrame;
}

function createReadyState(
  review: ReviewerReview,
  playback: StreamPlayback | "unavailable" | null,
  onDecision: DecisionSubmitter,
) {
  const main = createElement("main", "review-state-shell");
  main.dataset.reviewState = "ready";

  const heading = createElement("header", "review-heading");
  const eyebrow = createElement("p", "eyebrow");
  eyebrow.textContent = "Review request";
  const titleElement = createElement("h1", "review-title");
  titleElement.textContent = review.title;
  const introduction = createElement("p", "review-introduction");
  introduction.textContent =
    "An agent has prepared focused evidence for your judgment.";
  heading.append(eyebrow, titleElement, introduction);

  const layout = createElement("div", "review-layout");
  const evidence = createElement(
    "section",
    "review-panel review-evidence-panel",
  );
  evidence.setAttribute("aria-labelledby", "evidence-title");
  const evidenceHeading = createElement("div", "review-panel-heading");
  const evidenceTitle = createElement("h2");
  evidenceTitle.id = "evidence-title";
  evidenceTitle.textContent = "Evidence";
  const evidenceKind = createElement("span", "review-kind");
  evidenceKind.textContent = "Browser recording";
  evidenceHeading.append(evidenceTitle, evidenceKind);

  evidence.append(evidenceHeading, createPlaybackFrame(review, playback));

  layout.append(evidence, createReviewDetails(review, onDecision));
  main.append(heading, layout);
  return main;
}

function createErrorState() {
  const main = createElement("main", "review-state-shell review-error");
  main.dataset.reviewState = "error";
  const card = createElement("section", "review-error-card");
  card.setAttribute("aria-labelledby", "review-error-title");

  const marker = createElement("p", "review-error-marker");
  marker.textContent = "Review unavailable";
  const title = createElement("h1", "review-error-title");
  title.id = "review-error-title";
  title.textContent = "We couldn’t load this review.";
  const detail = createElement("p", "review-error-copy");
  detail.textContent =
    "The link may have expired, or the review may be temporarily unavailable.";
  const homeLink = createElement("a", "review-home-action");
  homeLink.href = "/";
  homeLink.textContent = "Return to AirUX";
  card.append(marker, title, detail, homeLink);
  main.append(card);
  return main;
}

function createSignInState(
  onSignIn: (button: HTMLButtonElement, status: HTMLParagraphElement) => void,
) {
  const main = createElement("main", "review-state-shell review-auth-state");
  main.dataset.reviewState = "signed-out";
  const card = createElement("section", "review-auth-card");
  card.setAttribute("aria-labelledby", "review-auth-title");

  const marker = createElement("p", "eyebrow");
  marker.textContent = "Private review";
  const title = createElement("h1", "review-auth-title");
  title.id = "review-auth-title";
  title.textContent = "Sign in to review this work.";
  const copy = createElement("p", "review-auth-copy");
  copy.textContent =
    "Review links identify the work to inspect, but they do not grant access to its private evidence.";
  const button = createElement("button", "primary-action review-sign-in");
  button.type = "button";
  button.textContent = "Continue with GitHub";
  const status = createElement("p", "review-auth-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const note = createElement("p", "review-auth-note");
  note.textContent = "After signing in, you’ll return directly to this Review.";
  button.addEventListener("click", () => {
    onSignIn(button, status);
  });
  card.append(marker, title, copy, button, status, note);
  main.append(card);
  return main;
}

function createAuthErrorState(retryHref: string) {
  const main = createElement("main", "review-state-shell review-auth-state");
  main.dataset.reviewState = "auth-error";
  const card = createElement("section", "review-auth-card");
  card.setAttribute("aria-labelledby", "review-auth-error-title");

  const marker = createElement("p", "review-error-marker");
  marker.textContent = "Sign-in unavailable";
  const title = createElement("h1", "review-auth-title");
  title.id = "review-auth-error-title";
  title.textContent = "We couldn’t verify your session.";
  const copy = createElement("p", "review-auth-copy");
  copy.textContent =
    "Your Review remains private. Try again when sign-in is available.";
  const retry = createElement("a", "review-home-action");
  retry.href = retryHref;
  retry.textContent = "Try again";
  card.append(marker, title, copy, retry);
  main.append(card);
  return main;
}

function renderPageState(state: HTMLElement, account?: ReviewHeaderAccount) {
  document.body.replaceChildren(createBrandHeader(account), state);
}

function clearOAuthParameters() {
  const cleanPath = getOAuthCallbackCleanupPath(window.location.href);
  if (cleanPath !== null) {
    window.history.replaceState({}, "", cleanPath);
  }
}

export async function initializeReviewPage(
  route: ReviewRoute,
  searchParams: URLSearchParams,
) {
  document.body.classList.add("review-body");
  document.title = "Review | AirUX";
  renderPageState(createLoadingState());
  let authClient: SupabaseClient | undefined;
  let renderSequence = 0;

  const renderSession = async (session: Session | null) => {
    const sequence = ++renderSequence;
    if (session === null) {
      document.title = "Sign in to review | AirUX";
      renderPageState(
        createSignInState((button, status) => {
          if (authClient === undefined) {
            return;
          }
          button.disabled = true;
          status.textContent = "Redirecting to GitHub…";
          void signInToReview(authClient.auth, window.location.href).catch(
            () => {
              button.disabled = false;
              status.textContent =
                "GitHub sign-in could not be started. Please try again.";
            },
          );
        }),
      );
      return;
    }

    const account = {
      displayName: getSessionDisplayName(session) ?? "GitHub user",
      onSignOut: (button: HTMLButtonElement, status: HTMLParagraphElement) => {
        if (authClient === undefined) {
          return;
        }
        button.disabled = true;
        status.textContent = "Signing out…";
        void signOutFromReview(authClient.auth)
          .then(() => renderSession(null))
          .catch(() => {
            button.disabled = false;
            status.textContent = "Sign-out failed. Please try again.";
          });
      },
    } satisfies ReviewHeaderAccount;
    renderPageState(createLoadingState(), account);

    try {
      const fixtureMode = getReviewFixtureMode(searchParams);
      const review =
        fixtureMode === null
          ? await getReviewerReview(route.reviewId, session.access_token)
          : await loadReviewFixture(route.reviewId, fixtureMode);
      let playback: StreamPlayback | "unavailable" | null = null;
      if (fixtureMode === null && review.evidence.status === "ready") {
        try {
          playback = await createReviewPlayback(
            review.evidence.id,
            session.access_token,
          );
        } catch {
          playback = "unavailable";
        }
      }
      if (sequence !== renderSequence) {
        return;
      }
      const renderReview = (
        currentReview: ReviewerReview,
        currentPlayback: StreamPlayback | "unavailable" | null,
      ) => {
        const onDecision: DecisionSubmitter = async (decision) => {
          let decidedReview: ReviewerReview;
          try {
            decidedReview =
              fixtureMode === null
                ? await submitReviewDecision(
                    currentReview.id,
                    session.access_token,
                    decision,
                  )
                : decideReviewFixture(currentReview, decision);
          } catch (error) {
            if (error instanceof ReviewApiError && error.status === 409) {
              await renderSession(session);
              return;
            }
            throw error;
          }
          if (sequence !== renderSequence) {
            return;
          }
          document.title = `${decidedReview.title} | AirUX`;
          renderReview(decidedReview, currentPlayback);
        };

        document.title = `${currentReview.title} | AirUX`;
        renderPageState(
          createReadyState(currentReview, currentPlayback, onDecision),
          account,
        );
      };
      renderReview(review, playback);
    } catch {
      if (sequence !== renderSequence) {
        return;
      }
      document.title = "Review unavailable | AirUX";
      renderPageState(createErrorState(), account);
    }
  };

  try {
    const config = await loadBrowserConfig();
    authClient = createReviewerAuthClient(config, window.localStorage);
    const session = await restoreReviewSession(authClient.auth);
    clearOAuthParameters();
    observeReviewSession(authClient.auth, (nextSession) => {
      void renderSession(nextSession);
    });
    await renderSession(session);
  } catch {
    clearOAuthParameters();
    document.title = "Sign-in unavailable | AirUX";
    const cleanUrl = new URL(window.location.href);
    renderPageState(
      createAuthErrorState(
        `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`,
      ),
    );
  }
}
