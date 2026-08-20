import {
  type EvidenceState,
  evidenceStateSchema,
  type ReviewState,
  reviewStateSchema,
} from "@airux/shared/v1";

import { readJsonResponse } from "./bounded-json.js";
import type { AiruxConfig } from "./config.js";

const DATA_RESPONSE_LIMIT = 64 * 1024;
const DATA_ERROR_RESPONSE_LIMIT = 16 * 1024;
const INVALID_TRANSITION_CODE = "P0001";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ReviewTransitionResult {
  readonly reviewId: string;
  readonly status: ReviewState;
  readonly version: number;
  readonly submittedAt: string | null;
  readonly resolvedAt: string | null;
}

export interface EvidenceTransitionResult {
  readonly evidenceId: string;
  readonly reviewId: string;
  readonly status: EvidenceState;
  readonly failureCode: string | null;
  readonly deletedAt: string | null;
}

export interface ReviewTransition {
  readonly reviewId: string;
  readonly expectedStatus: ReviewState;
  readonly targetStatus: ReviewState;
  readonly expectedVersion?: number;
}

export interface EvidenceTransition {
  readonly evidenceId: string;
  readonly expectedStatus: EvidenceState;
  readonly targetStatus: EvidenceState;
  readonly failureCode?: string;
}

export class InvalidStateTransitionError extends Error {}
export class StateTransitionConflictError extends Error {}
export class StateTransitionServiceError extends Error {}

function isInvalidTransitionMessage(message: string) {
  return (
    message === "invalid review state transition" ||
    message === "invalid evidence state transition" ||
    message === "review evidence is not ready"
  );
}

function rpcUrl(config: AiruxConfig, functionName: string) {
  return new URL(`/rest/v1/rpc/${functionName}`, config.supabase.url);
}

function rpcHeaders(config: AiruxConfig) {
  return {
    accept: "application/json",
    apikey: config.supabase.secretKey,
    "content-type": "application/json",
  };
}

async function fetchTransition(
  url: URL,
  body: Record<string, unknown>,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: rpcHeaders(config),
      body: JSON.stringify(body),
      redirect: "manual",
    });
  } catch {
    throw new StateTransitionServiceError();
  }

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await readJsonResponse(response, DATA_ERROR_RESPONSE_LIMIT);
    } catch {
      throw new StateTransitionServiceError();
    }

    if (
      typeof errorBody === "object" &&
      errorBody !== null &&
      "code" in errorBody &&
      errorBody.code === INVALID_TRANSITION_CODE &&
      "message" in errorBody &&
      typeof errorBody.message === "string" &&
      isInvalidTransitionMessage(errorBody.message)
    ) {
      throw new InvalidStateTransitionError();
    }

    throw new StateTransitionServiceError();
  }

  let rows: unknown;
  try {
    rows = await readJsonResponse(response, DATA_RESPONSE_LIMIT);
  } catch {
    throw new StateTransitionServiceError();
  }

  if (!Array.isArray(rows) || rows.length > 1) {
    throw new StateTransitionServiceError();
  }
  if (rows.length === 0) {
    throw new StateTransitionConflictError();
  }
  return rows[0];
}

function normalizeTimestamp(value: unknown) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? undefined
    : timestamp.toISOString();
}

function normalizeReviewResult(
  value: unknown,
  transition: ReviewTransition,
): ReviewTransitionResult {
  if (typeof value !== "object" || value === null) {
    throw new StateTransitionServiceError();
  }

  const row = value as Record<string, unknown>;
  const status = reviewStateSchema.safeParse(row.status);
  const submittedAt = normalizeTimestamp(row.submitted_at);
  const resolvedAt = normalizeTimestamp(row.resolved_at);
  if (
    row.review_id !== transition.reviewId ||
    !status.success ||
    status.data !== transition.targetStatus ||
    typeof row.version !== "number" ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0 ||
    submittedAt === undefined ||
    resolvedAt === undefined
  ) {
    throw new StateTransitionServiceError();
  }

  if (transition.expectedVersion !== undefined) {
    const expectedResultVersion =
      transition.expectedStatus === transition.targetStatus
        ? transition.expectedVersion
        : transition.expectedVersion + 1;
    if (row.version !== expectedResultVersion) {
      throw new StateTransitionServiceError();
    }
  }

  return {
    reviewId: transition.reviewId,
    status: status.data,
    version: row.version,
    submittedAt,
    resolvedAt,
  };
}

function normalizeEvidenceResult(
  value: unknown,
  transition: EvidenceTransition,
): EvidenceTransitionResult {
  if (typeof value !== "object" || value === null) {
    throw new StateTransitionServiceError();
  }

  const row = value as Record<string, unknown>;
  const status = evidenceStateSchema.safeParse(row.status);
  const deletedAt = normalizeTimestamp(row.deleted_at);
  if (
    row.evidence_id !== transition.evidenceId ||
    typeof row.review_id !== "string" ||
    !UUID_PATTERN.test(row.review_id) ||
    !status.success ||
    status.data !== transition.targetStatus ||
    (row.failure_code !== null && typeof row.failure_code !== "string") ||
    deletedAt === undefined
  ) {
    throw new StateTransitionServiceError();
  }

  return {
    evidenceId: transition.evidenceId,
    reviewId: row.review_id,
    status: status.data,
    failureCode: row.failure_code,
    deletedAt,
  };
}

export async function transitionReviewState(
  transition: ReviewTransition,
  config: AiruxConfig,
  fetcher: Fetcher = fetch,
) {
  const row = await fetchTransition(
    rpcUrl(config, "transition_review_state"),
    {
      p_review_id: transition.reviewId,
      p_expected_status: transition.expectedStatus,
      p_target_status: transition.targetStatus,
      p_expected_version: transition.expectedVersion ?? null,
    },
    config,
    fetcher,
  );
  return normalizeReviewResult(row, transition);
}

export async function transitionEvidenceState(
  transition: EvidenceTransition,
  config: AiruxConfig,
  fetcher: Fetcher = fetch,
) {
  const row = await fetchTransition(
    rpcUrl(config, "transition_evidence_state"),
    {
      p_evidence_id: transition.evidenceId,
      p_expected_status: transition.expectedStatus,
      p_target_status: transition.targetStatus,
      p_failure_code: transition.failureCode ?? null,
    },
    config,
    fetcher,
  );
  return normalizeEvidenceResult(row, transition);
}
