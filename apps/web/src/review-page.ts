import { getReviewFixtureMode, loadReviewFixture } from "./review-fixture.js";
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

function createReadyState(title: string) {
  const main = createElement("main", "review-state-shell");
  main.dataset.reviewState = "ready";

  const heading = createElement("header", "review-heading");
  const eyebrow = createElement("p", "eyebrow");
  eyebrow.textContent = "Review request";
  const titleElement = createElement("h1", "review-title");
  titleElement.textContent = title;
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

  const details = createElement("aside", "review-panel review-detail-panel");
  details.setAttribute("aria-labelledby", "details-title");
  const detailsTitle = createElement("h2");
  detailsTitle.id = "details-title";
  detailsTitle.textContent = "Review details";
  const detailsCopy = createElement("p", "review-detail-copy");
  detailsCopy.textContent =
    "The claim, review criteria, status, and decision controls will be presented alongside the evidence.";
  const boundary = createElement("p", "review-boundary");
  boundary.textContent =
    "Approval applies only to the stated claim and the evidence shown.";
  details.append(detailsTitle, detailsCopy, boundary);

  layout.append(evidence, details);
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
    renderPageState(createReadyState(review.title));
  } catch {
    document.title = "Review unavailable | AirUX";
    renderPageState(createErrorState());
  }
}
