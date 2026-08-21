import type { ReviewerReview } from "@airux/shared/v1";

import { getReviewFixtureMode, loadReviewFixture } from "./review-fixture.js";
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

function createBrandHeader() {
  const header = createElement("header", "review-site-header");
  const homeLink = createElement("a", "review-wordmark");
  homeLink.href = "/";
  homeLink.textContent = "AirUX";
  homeLink.setAttribute("aria-label", "AirUX home");

  const context = createElement("p", "review-site-context");
  context.textContent = "Human review";
  header.append(homeLink, context);
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

function createReviewDetails(review: ReviewerReview) {
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

  const decision = createElement("section", "review-decision");
  decision.setAttribute("aria-labelledby", "decision-title");
  const decisionTitle = createElement("h2");
  decisionTitle.id = "decision-title";
  decisionTitle.textContent = "Your decision";
  const decisionHint = createElement("p", "review-decision-hint");
  decisionHint.id = "decision-hint";
  decisionHint.textContent =
    "Decision submission is not yet available in this fixture preview.";
  const decisionActions = createElement("div", "review-decision-actions");
  const approveButton = createElement(
    "button",
    "review-decision-button review-approve-action",
  );
  approveButton.type = "button";
  approveButton.disabled = true;
  approveButton.setAttribute("aria-describedby", decisionHint.id);
  approveButton.textContent = "Approve";
  const requestChangesButton = createElement(
    "button",
    "review-decision-button review-changes-action",
  );
  requestChangesButton.type = "button";
  requestChangesButton.disabled = true;
  requestChangesButton.setAttribute("aria-describedby", decisionHint.id);
  requestChangesButton.textContent = "Request changes";
  decisionActions.append(approveButton, requestChangesButton);
  decision.append(decisionTitle, decisionActions, decisionHint);

  details.append(statusRow, claim, criteria, boundary, decision);
  return details;
}

function createReadyState(review: ReviewerReview) {
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

  const evidenceFrame = createElement("div", "review-video-shell");
  const browserBar = createElement("div", "review-browser-bar");
  browserBar.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    browserBar.append(createElement("span"));
  }
  const evidencePlaceholder = createElement("div", "review-video-placeholder");
  const playMark = createElement("span", "review-play-mark");
  playMark.textContent = "▶";
  playMark.setAttribute("aria-hidden", "true");
  const placeholderText = createElement("p");
  placeholderText.textContent = "Private playback will appear here";
  evidencePlaceholder.append(playMark, placeholderText);
  evidenceFrame.append(browserBar, evidencePlaceholder);
  evidence.append(evidenceHeading, evidenceFrame);

  layout.append(evidence, createReviewDetails(review));
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

function renderPageState(state: HTMLElement) {
  document.body.replaceChildren(createBrandHeader(), state);
}

export async function initializeReviewPage(
  route: ReviewRoute,
  searchParams: URLSearchParams,
) {
  document.body.classList.add("review-body");
  document.title = "Review | AirUX";
  renderPageState(createLoadingState());

  try {
    const review = await loadReviewFixture(
      route.reviewId,
      getReviewFixtureMode(searchParams),
    );
    document.title = `${review.title} | AirUX`;
    renderPageState(createReadyState(review));
  } catch {
    document.title = "Review unavailable | AirUX";
    renderPageState(createErrorState());
  }
}
