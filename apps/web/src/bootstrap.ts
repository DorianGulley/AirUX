import { matchReviewRoute } from "./review-route.js";

const reviewRoute = matchReviewRoute(window.location.pathname);

if (reviewRoute === null) {
  await import("./main.js");
} else {
  document.body.replaceChildren();
  const { initializeReviewPage } = await import("./review-page.js");
  await initializeReviewPage(
    reviewRoute,
    new URL(window.location.href).searchParams,
  );
}
