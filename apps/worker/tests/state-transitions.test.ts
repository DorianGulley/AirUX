import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  InvalidStateTransitionError,
  StateTransitionConflictError,
  StateTransitionServiceError,
  transitionEvidenceState,
  transitionReviewState,
} from "../src/state-transitions.js";
import { TEST_ENV } from "./fixtures.js";

const REVIEW_ID = "20000000-0000-4000-8000-000000000001";
const EVIDENCE_ID = "30000000-0000-4000-8000-000000000001";
const CONFIG = loadConfig(TEST_ENV);

describe("Review state transitions", () => {
  it("calls the transactional RPC and normalizes the result", async () => {
    const fetcher = vi.fn(async () =>
      Response.json([
        {
          review_id: REVIEW_ID,
          status: "pending",
          version: 4,
          submitted_at: "2026-08-20T06:30:00+00:00",
          resolved_at: null,
        },
      ]),
    );

    const result = await transitionReviewState(
      {
        reviewId: REVIEW_ID,
        expectedStatus: "draft",
        targetStatus: "pending",
        expectedVersion: 3,
      },
      CONFIG,
      fetcher,
    );

    expect(result).toEqual({
      reviewId: REVIEW_ID,
      status: "pending",
      version: 4,
      submittedAt: "2026-08-20T06:30:00.000Z",
      resolvedAt: null,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe(
      "https://example.supabase.co/rest/v1/rpc/transition_review_state",
    );
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(JSON.parse(String(init?.body))).toEqual({
      p_review_id: REVIEW_ID,
      p_expected_status: "draft",
      p_target_status: "pending",
      p_expected_version: 3,
    });
    expect(new Headers(init?.headers).get("apikey")).toBe(
      TEST_ENV.SUPABASE_SECRET_KEY,
    );
  });

  it("treats an unmet state or version expectation as a conflict", async () => {
    const fetcher = vi.fn(async () => Response.json([]));

    await expect(
      transitionReviewState(
        {
          reviewId: REVIEW_ID,
          expectedStatus: "pending",
          targetStatus: "approved",
          expectedVersion: 2,
        },
        CONFIG,
        fetcher,
      ),
    ).rejects.toBeInstanceOf(StateTransitionConflictError);
  });

  it("rejects an invalid transition reported by Postgres", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          code: "P0001",
          message: "invalid review state transition",
        },
        { status: 400 },
      ),
    );

    await expect(
      transitionReviewState(
        {
          reviewId: REVIEW_ID,
          expectedStatus: "draft",
          targetStatus: "approved",
        },
        CONFIG,
        fetcher,
      ),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });
});

describe("Evidence state transitions", () => {
  it("passes failure context to the RPC", async () => {
    const fetcher = vi.fn(async () =>
      Response.json([
        {
          evidence_id: EVIDENCE_ID,
          review_id: REVIEW_ID,
          status: "failed",
          failure_code: "stream_processing_failed",
          deleted_at: null,
        },
      ]),
    );

    await expect(
      transitionEvidenceState(
        {
          evidenceId: EVIDENCE_ID,
          expectedStatus: "processing",
          targetStatus: "failed",
          failureCode: "stream_processing_failed",
        },
        CONFIG,
        fetcher,
      ),
    ).resolves.toEqual({
      evidenceId: EVIDENCE_ID,
      reviewId: REVIEW_ID,
      status: "failed",
      failureCode: "stream_processing_failed",
      deletedAt: null,
    });

    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      p_evidence_id: EVIDENCE_ID,
      p_expected_status: "processing",
      p_target_status: "failed",
      p_failure_code: "stream_processing_failed",
    });
  });

  it("rejects malformed backend results", async () => {
    const fetcher = vi.fn(async () =>
      Response.json([
        {
          evidence_id: EVIDENCE_ID,
          review_id: REVIEW_ID,
          status: "ready",
          failure_code: null,
          deleted_at: "not-a-timestamp",
        },
      ]),
    );

    await expect(
      transitionEvidenceState(
        {
          evidenceId: EVIDENCE_ID,
          expectedStatus: "processing",
          targetStatus: "ready",
        },
        CONFIG,
        fetcher,
      ),
    ).rejects.toBeInstanceOf(StateTransitionServiceError);
  });

  it("maps network failures to service errors", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network unavailable");
    });

    await expect(
      transitionEvidenceState(
        {
          evidenceId: EVIDENCE_ID,
          expectedStatus: "ready",
          targetStatus: "deleting",
        },
        CONFIG,
        fetcher,
      ),
    ).rejects.toBeInstanceOf(StateTransitionServiceError);
  });
});
