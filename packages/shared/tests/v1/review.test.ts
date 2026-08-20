import { describe, expect, it } from "vitest";

import {
  API_ERROR_CODES,
  agentReviewSchema,
  CONTRACT_LIMITS,
  createReviewRequestSchema,
  createReviewResponseSchema,
  decisionRequestSchema,
  decisionSchema,
  EVIDENCE_STATES,
  evidenceSchema,
  evidenceStateSchema,
  REVIEW_STATES,
  reviewSchema,
  reviewStateSchema,
} from "../../src/v1/index.js";

const validCreateRequest = {
  client_request_id: "agent-run-42",
  title: "Review the new onboarding flow",
  claim: "The mobile onboarding flow is complete.",
  criteria: [
    { id: "layout", prompt: "The layout fits a narrow viewport." },
    { id: "transition", prompt: "The step transition feels natural." },
  ],
  evidence: {
    kind: "browser_video",
    media_type: "video/webm",
    size_bytes: 1_024,
  },
};

describe("lifecycle state schemas", () => {
  it("accepts every documented Review state", () => {
    for (const state of REVIEW_STATES) {
      expect(reviewStateSchema.parse(state)).toBe(state);
    }
  });

  it("accepts every documented Evidence state", () => {
    for (const state of EVIDENCE_STATES) {
      expect(evidenceStateSchema.parse(state)).toBe(state);
    }
  });

  it("rejects undocumented states", () => {
    expect(reviewStateSchema.safeParse("ready").success).toBe(false);
    expect(evidenceStateSchema.safeParse("cancelled").success).toBe(false);
  });

  it("keeps API error codes distinct from lifecycle states", () => {
    expect(API_ERROR_CODES).not.toContain("approved");
  });
});

describe("createReviewRequestSchema", () => {
  it("accepts the documented browser-video request", () => {
    expect(createReviewRequestSchema.parse(validCreateRequest)).toEqual(
      validCreateRequest,
    );
  });

  it("rejects duplicate criterion IDs", () => {
    expect(
      createReviewRequestSchema.safeParse({
        ...validCreateRequest,
        criteria: [
          validCreateRequest.criteria[0],
          {
            id: validCreateRequest.criteria[0]?.id,
            prompt: "A different prompt with the same ID.",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects non-video evidence", () => {
    expect(
      createReviewRequestSchema.safeParse({
        ...validCreateRequest,
        evidence: {
          ...validCreateRequest.evidence,
          media_type: "image/png",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields at every contract boundary", () => {
    expect(
      createReviewRequestSchema.safeParse({
        ...validCreateRequest,
        evidence: { ...validCreateRequest.evidence, provider_url: "secret" },
      }).success,
    ).toBe(false);
  });

  it("caps basic Stream uploads at 200 MiB", () => {
    expect(CONTRACT_LIMITS.mediaSizeBytes).toBe(200 * 1024 * 1024);
    expect(
      createReviewRequestSchema.safeParse({
        ...validCreateRequest,
        evidence: {
          ...validCreateRequest.evidence,
          size_bytes: CONTRACT_LIMITS.mediaSizeBytes + 1,
        },
      }).success,
    ).toBe(false);
  });
});

describe("Review and Evidence resources", () => {
  const timestamps = {
    created_at: "2026-08-12T01:00:00Z",
    deleted_at: null,
  };

  it("accepts a complete Review resource", () => {
    expect(
      reviewSchema.safeParse({
        id: "rvw_1",
        user_id: "usr_1",
        agent_credential_id: "agc_1",
        client_request_id: "agent-run-42",
        title: validCreateRequest.title,
        claim: validCreateRequest.claim,
        criteria: validCreateRequest.criteria,
        status: "pending",
        version: 1,
        ...timestamps,
        submitted_at: "2026-08-12T01:01:00Z",
        expires_at: "2026-08-15T01:01:00Z",
        resolved_at: null,
      }).success,
    ).toBe(true);
  });

  it("accepts an Evidence resource without a provider URL", () => {
    expect(
      evidenceSchema.safeParse({
        id: "evd_1",
        review_id: "rvw_1",
        kind: "browser_video",
        status: "ready",
        stream_video_id: "stream_1",
        media_type: "video/webm",
        size_bytes: 1_024,
        duration_ms: 15_000,
        width: 1_280,
        height: 720,
        failure_code: null,
        delete_after: "2026-08-19T01:00:00Z",
        ...timestamps,
      }).success,
    ).toBe(true);
  });

  it("requires UTC timestamps", () => {
    expect(
      reviewSchema.safeParse({
        id: "rvw_1",
        user_id: "usr_1",
        agent_credential_id: "agc_1",
        client_request_id: "agent-run-42",
        title: validCreateRequest.title,
        claim: validCreateRequest.claim,
        criteria: validCreateRequest.criteria,
        status: "draft",
        version: 0,
        ...timestamps,
        created_at: "2026-08-11T18:00:00-07:00",
        submitted_at: null,
        expires_at: "2026-08-12T02:00:00Z",
        resolved_at: null,
      }).success,
    ).toBe(false);
  });

  it("accepts the documented draft creation response", () => {
    expect(
      createReviewResponseSchema.safeParse({
        review_id: "rvw_1",
        review_url: "https://airux.app/reviews/rvw_1",
        status: "draft",
        evidence_id: "evd_1",
        upload_url: "https://upload.videodelivery.net/token",
        upload_expires_at: "2026-08-12T01:15:00Z",
      }).success,
    ).toBe(true);
  });

  it("defines an agent-safe Review without owner or provider fields", () => {
    const parsed = agentReviewSchema.parse({
      id: "rvw_1",
      review_url: "https://airux.app/reviews/rvw_1",
      client_request_id: "agent-run-42",
      title: validCreateRequest.title,
      claim: validCreateRequest.claim,
      criteria: validCreateRequest.criteria,
      status: "approved",
      version: 2,
      created_at: "2026-08-12T01:00:00Z",
      submitted_at: "2026-08-12T01:01:00Z",
      expires_at: "2026-08-15T01:01:00Z",
      resolved_at: "2026-08-12T01:02:00Z",
      evidence: {
        id: "evd_1",
        kind: "browser_video",
        status: "ready",
        media_type: "video/webm",
        size_bytes: 1_024,
        failure_code: null,
      },
      decision: {
        outcome: "approved",
        comment: null,
        created_at: "2026-08-12T01:02:00Z",
      },
    });

    expect(parsed.status).toBe("approved");
    expect(parsed).not.toHaveProperty("user_id");
    expect(parsed.evidence).not.toHaveProperty("stream_video_id");
    expect(parsed.evidence).not.toHaveProperty("delete_after");
  });
});

describe("Decision contracts", () => {
  it("allows approval without a comment", () => {
    expect(
      decisionRequestSchema.safeParse({
        expected_version: 2,
        outcome: "approved",
      }).success,
    ).toBe(true);
  });

  it("requires a non-empty comment when requesting changes", () => {
    expect(
      decisionRequestSchema.safeParse({
        expected_version: 2,
        outcome: "changes_requested",
      }).success,
    ).toBe(false);
    expect(
      decisionRequestSchema.safeParse({
        expected_version: 2,
        outcome: "changes_requested",
        comment: "The final transition is clipped.",
      }).success,
    ).toBe(true);
  });

  it("enforces the comment rule on persisted Decisions", () => {
    expect(
      decisionSchema.safeParse({
        id: "dec_1",
        review_id: "rvw_1",
        user_id: "usr_1",
        outcome: "changes_requested",
        comment: null,
        created_at: "2026-08-12T01:00:00Z",
      }).success,
    ).toBe(false);
  });
});
