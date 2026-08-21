export interface ReviewRoute {
  readonly reviewId: string;
}

const REVIEW_PATH = /^\/reviews\/([^/]+)\/?$/;

export function matchReviewRoute(pathname: string): ReviewRoute | null {
  const match = pathname.match(REVIEW_PATH);
  const encodedReviewId = match?.[1];
  if (encodedReviewId === undefined) {
    return null;
  }

  try {
    const reviewId = decodeURIComponent(encodedReviewId);
    if (reviewId.trim() === "" || reviewId.includes("/")) {
      return null;
    }
    return { reviewId };
  } catch {
    return null;
  }
}
