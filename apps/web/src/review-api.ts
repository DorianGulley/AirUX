import type {
  DecisionRequest,
  ReviewCriterion,
  ReviewerReview,
  ReviewerReviewDecision,
  ReviewerReviewEvidence,
  StreamPlayback,
} from "@airux/shared/v1";
import { CONTRACT_LIMITS } from "@airux/shared/v1/limits";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REVIEW_STATES = new Set([
  "draft",
  "pending",
  "approved",
  "changes_requested",
  "cancelled",
  "expired",
]);
const EVIDENCE_STATES = new Set([
  "awaiting_upload",
  "processing",
  "ready",
  "failed",
  "deleting",
  "deleted",
]);
const DECISION_OUTCOMES = new Set(["approved", "changes_requested"]);

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ReviewApiError extends Error {
  constructor(readonly status: number | null = null) {
    super();
    this.name = "ReviewApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isTrimmedText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function isReviewStatus(value: unknown): value is ReviewerReview["status"] {
  return typeof value === "string" && REVIEW_STATES.has(value);
}

function isEvidenceStatus(
  value: unknown,
): value is ReviewerReviewEvidence["status"] {
  return typeof value === "string" && EVIDENCE_STATES.has(value);
}

function isDecisionOutcome(
  value: unknown,
): value is ReviewerReviewDecision["outcome"] {
  return typeof value === "string" && DECISION_OUTCOMES.has(value);
}

function parseCriteria(value: unknown): ReviewCriterion[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    return null;
  }
  const criteria: ReviewCriterion[] = [];
  const ids = new Set<string>();
  for (const criterion of value) {
    if (
      !isRecord(criterion) ||
      !hasExactKeys(criterion, ["id", "prompt"]) ||
      !isTrimmedText(criterion.id) ||
      !isTrimmedText(criterion.prompt) ||
      ids.has(criterion.id)
    ) {
      return null;
    }
    ids.add(criterion.id);
    criteria.push({ id: criterion.id, prompt: criterion.prompt });
  }
  return criteria;
}

function parseEvidence(value: unknown): ReviewerReviewEvidence | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "kind",
      "status",
      "media_type",
      "size_bytes",
      "duration_ms",
      "width",
      "height",
      "failure_code",
    ]) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    value.kind !== "browser_video" ||
    !isEvidenceStatus(value.status) ||
    typeof value.media_type !== "string" ||
    !/^video\/[a-z0-9][a-z0-9.+-]*$/i.test(value.media_type) ||
    !isPositiveInteger(value.size_bytes) ||
    !isNullablePositiveInteger(value.duration_ms) ||
    !isNullablePositiveInteger(value.width) ||
    !isNullablePositiveInteger(value.height) ||
    (value.failure_code !== null && !isTrimmedText(value.failure_code))
  ) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind,
    status: value.status,
    media_type: value.media_type,
    size_bytes: value.size_bytes,
    duration_ms: value.duration_ms,
    width: value.width,
    height: value.height,
    failure_code: value.failure_code,
  };
}

function parseDecision(value: unknown): ReviewerReviewDecision | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["outcome", "comment", "created_at"]) ||
    !isDecisionOutcome(value.outcome) ||
    (value.comment !== null && !isTrimmedText(value.comment)) ||
    (value.outcome === "changes_requested" && value.comment === null) ||
    !isUtcTimestamp(value.created_at)
  ) {
    return null;
  }
  return {
    outcome: value.outcome,
    comment: value.comment,
    created_at: value.created_at,
  };
}

function parseReview(value: unknown): ReviewerReview | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "title",
      "claim",
      "criteria",
      "status",
      "version",
      "created_at",
      "submitted_at",
      "expires_at",
      "resolved_at",
      "evidence",
      "decision",
    ]) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !isTrimmedText(value.title) ||
    !isTrimmedText(value.claim) ||
    !isReviewStatus(value.status) ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    value.version < 0 ||
    !isUtcTimestamp(value.created_at) ||
    (value.submitted_at !== null && !isUtcTimestamp(value.submitted_at)) ||
    !isUtcTimestamp(value.expires_at) ||
    (value.resolved_at !== null && !isUtcTimestamp(value.resolved_at))
  ) {
    return null;
  }
  const criteria = parseCriteria(value.criteria);
  const evidence = parseEvidence(value.evidence);
  const decision =
    value.decision === null ? null : parseDecision(value.decision);
  if (
    criteria === null ||
    evidence === null ||
    (value.decision !== null && decision === null)
  ) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    claim: value.claim,
    criteria,
    status: value.status,
    version: value.version,
    created_at: value.created_at,
    submitted_at: value.submitted_at,
    expires_at: value.expires_at,
    resolved_at: value.resolved_at,
    evidence,
    decision,
  };
}

function parsePlayback(value: unknown): StreamPlayback | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["token", "player_url", "expires_at"]) ||
    typeof value.token !== "string" ||
    !ACCESS_TOKEN_PATTERN.test(value.token) ||
    value.token.length > 8_192 ||
    typeof value.player_url !== "string" ||
    !isUtcTimestamp(value.expires_at)
  ) {
    return null;
  }
  const expectedPlayerUrl = new RegExp(
    `^https://customer-[a-z0-9]+\\.cloudflarestream\\.com/${value.token.replaceAll(".", "\\.")}/iframe$`,
  );
  if (!expectedPlayerUrl.test(value.player_url)) {
    return null;
  }
  return {
    token: value.token,
    player_url: value.player_url,
    expires_at: value.expires_at,
  };
}

function authorizationHeaders(accessToken: string) {
  if (!ACCESS_TOKEN_PATTERN.test(accessToken) || accessToken.length > 8_192) {
    throw new ReviewApiError();
  }
  return { authorization: `Bearer ${accessToken}` };
}

async function readResponse(response: Response) {
  if (!response.ok) {
    throw new ReviewApiError(response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new ReviewApiError();
  }
}

function normalizeDecisionRequest(decision: DecisionRequest) {
  if (
    !Number.isInteger(decision.expected_version) ||
    decision.expected_version < 0 ||
    !isDecisionOutcome(decision.outcome) ||
    (decision.comment !== undefined &&
      (typeof decision.comment !== "string" ||
        decision.comment.trim().length < 1 ||
        decision.comment.trim().length > CONTRACT_LIMITS.commentLength))
  ) {
    throw new ReviewApiError();
  }
  const comment = decision.comment?.trim();
  if (decision.outcome === "changes_requested" && comment === undefined) {
    throw new ReviewApiError();
  }
  return {
    expected_version: decision.expected_version,
    outcome: decision.outcome,
    ...(comment === undefined ? {} : { comment }),
  } satisfies DecisionRequest;
}

function requireIdentifier(value: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new ReviewApiError();
  }
  return encodeURIComponent(value);
}

export async function getReviewerReview(
  reviewId: string,
  accessToken: string,
  fetcher: Fetcher = fetch,
) {
  const response = await fetcher(
    `/api/v1/reviews/${requireIdentifier(reviewId)}`,
    {
      method: "GET",
      headers: authorizationHeaders(accessToken),
    },
  );
  const body: unknown = await readResponse(response);
  if (!isRecord(body) || !hasExactKeys(body, ["review"])) {
    throw new ReviewApiError();
  }
  const review = parseReview(body.review);
  if (review === null) {
    throw new ReviewApiError();
  }
  return review;
}

export async function createReviewPlayback(
  evidenceId: string,
  accessToken: string,
  fetcher: Fetcher = fetch,
) {
  const response = await fetcher(
    `/api/v1/evidence/${requireIdentifier(evidenceId)}/playback-token`,
    {
      method: "POST",
      headers: authorizationHeaders(accessToken),
    },
  );
  const body: unknown = await readResponse(response);
  if (!isRecord(body) || !hasExactKeys(body, ["playback"])) {
    throw new ReviewApiError();
  }
  const playback = parsePlayback(body.playback);
  if (playback === null) {
    throw new ReviewApiError();
  }
  return playback;
}

export async function submitReviewDecision(
  reviewId: string,
  accessToken: string,
  decision: DecisionRequest,
  fetcher: Fetcher = fetch,
) {
  const normalizedDecision = normalizeDecisionRequest(decision);
  const response = await fetcher(
    `/api/v1/reviews/${requireIdentifier(reviewId)}/decision`,
    {
      method: "POST",
      headers: {
        ...authorizationHeaders(accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify(normalizedDecision),
    },
  );
  const body: unknown = await readResponse(response);
  if (!isRecord(body) || !hasExactKeys(body, ["review"])) {
    throw new ReviewApiError();
  }
  const review = parseReview(body.review);
  const expectedComment = normalizedDecision.comment ?? null;
  if (
    review === null ||
    review.id !== reviewId ||
    review.status !== normalizedDecision.outcome ||
    review.version !== normalizedDecision.expected_version + 1 ||
    review.resolved_at === null ||
    review.decision === null ||
    review.decision.outcome !== normalizedDecision.outcome ||
    review.decision.comment !== expectedComment
  ) {
    throw new ReviewApiError();
  }
  return review;
}
