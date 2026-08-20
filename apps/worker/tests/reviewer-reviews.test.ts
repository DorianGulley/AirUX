import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  handleReviewerReviewDecision,
  handleReviewerReviewGet,
} from "../src/reviewer-reviews.js";
import { TEST_ENV } from "./fixtures.js";

const CONFIG = loadConfig(TEST_ENV);
const REVIEWER = { id: "fa2a3aca-e4c6-40fe-bb92-e422f3350806" };
const OTHER_REVIEWER_ID = "eb2d9347-652c-43ba-8e8c-81ac9a17d909";
const REVIEW_ID = "8d4ddde8-b58f-4c2c-b37f-b3ea1fb312da";
const EVIDENCE_ID = "347a6473-e510-4d6a-918f-b2bd56d942b7";
const DECISION_ID = "4e295f6a-9367-4871-8cbd-1337306d0136";

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    user_id: REVIEWER.id,
    agent_credential_id: "dc0fb4f8-652b-4e12-8899-e12c34afbcde",
    client_request_id: "private-agent-request",
    title: "Review the responsive layout",
    claim: "The navigation works at mobile width.",
    criteria: [{ id: "layout", prompt: "The navigation remains visible." }],
    status: "pending",
    version: 1,
    created_at: "2026-08-20T08:00:00+00:00",
    submitted_at: "2026-08-20T08:01:00+00:00",
    expires_at: "2026-08-23T08:01:00+00:00",
    resolved_at: null,
    ...overrides,
  };
}

function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVIDENCE_ID,
    review_id: REVIEW_ID,
    kind: "browser_video",
    status: "ready",
    stream_video_id: "private-stream-id",
    media_type: "video/webm",
    size_bytes: 1_024,
    duration_ms: 15_000,
    width: 1_280,
    height: 720,
    failure_code: null,
    delete_after: "2026-08-27T08:00:00+00:00",
    ...overrides,
  };
}

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DECISION_ID,
    review_id: REVIEW_ID,
    user_id: REVIEWER.id,
    outcome: "approved",
    comment: null,
    created_at: "2026-08-20T08:02:00+00:00",
    ...overrides,
  };
}

function decisionTransactionRow(overrides: Record<string, unknown> = {}) {
  return {
    review_id: REVIEW_ID,
    user_id: REVIEWER.id,
    title: "Review the responsive layout",
    claim: "The navigation works at mobile width.",
    criteria: [{ id: "layout", prompt: "The navigation remains visible." }],
    status: "approved",
    version: 2,
    created_at: "2026-08-20T08:00:00+00:00",
    submitted_at: "2026-08-20T08:01:00+00:00",
    expires_at: "2026-08-23T08:01:00+00:00",
    resolved_at: "2026-08-20T08:02:00+00:00",
    evidence_id: EVIDENCE_ID,
    evidence_review_id: REVIEW_ID,
    evidence_kind: "browser_video",
    evidence_status: "ready",
    media_type: "video/webm",
    size_bytes: 1_024,
    duration_ms: 15_000,
    width: 1_280,
    height: 720,
    failure_code: null,
    decision_id: DECISION_ID,
    decision_user_id: REVIEWER.id,
    outcome: "approved",
    comment: null,
    decision_created_at: "2026-08-20T08:02:00+00:00",
    ...overrides,
  };
}

function detailFetcher(options: {
  review?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  decision?: Record<string, unknown> | null;
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/reviews") {
      return Response.json([reviewRow(options.review)]);
    }
    if (url.pathname === "/rest/v1/evidence") {
      return Response.json([evidenceRow(options.evidence)]);
    }
    if (url.pathname === "/rest/v1/decisions") {
      return Response.json(
        options.decision === null ? [] : [decisionRow(options.decision)],
      );
    }
    return new Response(null, { status: 404 });
  });
}

function decisionRequest(body: unknown) {
  return new Request(
    `https://airux.example/api/v1/reviews/${REVIEW_ID}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("reviewer Review retrieval", () => {
  it("returns presentation metadata without internal ownership or provider fields", async () => {
    const fetcher = detailFetcher({ decision: null });
    const response = await handleReviewerReviewGet(
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      review: {
        id: REVIEW_ID,
        title: "Review the responsive layout",
        claim: "The navigation works at mobile width.",
        criteria: [{ id: "layout", prompt: "The navigation remains visible." }],
        status: "pending",
        version: 1,
        created_at: "2026-08-20T08:00:00.000Z",
        submitted_at: "2026-08-20T08:01:00.000Z",
        expires_at: "2026-08-23T08:01:00.000Z",
        resolved_at: null,
        evidence: {
          id: EVIDENCE_ID,
          kind: "browser_video",
          status: "ready",
          media_type: "video/webm",
          size_bytes: 1_024,
          duration_ms: 15_000,
          width: 1_280,
          height: 720,
          failure_code: null,
        },
        decision: null,
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("private-stream-id");
    expect(serialized).not.toContain("private-agent-request");
    expect(serialized).not.toContain("agent_credential_id");
    expect(serialized).not.toContain("delete_after");

    const reviewRequest = fetcher.mock.calls.find(([input]) =>
      String(input).includes("/rest/v1/reviews"),
    );
    const reviewUrl = new URL(String(reviewRequest?.[0]));
    expect(reviewUrl.searchParams.get("id")).toBe(`eq.${REVIEW_ID}`);
    expect(reviewUrl.searchParams.get("user_id")).toBe(`eq.${REVIEWER.id}`);
    expect(reviewUrl.searchParams.get("deleted_at")).toBe("is.null");
  });

  it("returns terminal Decision feedback to the owner", async () => {
    const response = await handleReviewerReviewGet(
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      detailFetcher({
        review: {
          status: "changes_requested",
          version: 2,
          resolved_at: "2026-08-20T08:02:00+00:00",
        },
        decision: {
          outcome: "changes_requested",
          comment: "The menu overlaps the heading.",
        },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      review: {
        status: "changes_requested",
        version: 2,
        decision: {
          outcome: "changes_requested",
          comment: "The menu overlaps the heading.",
        },
      },
    });
  });

  it("uses the same not-found response for malformed, missing, and foreign Reviews", async () => {
    const noFetch = vi.fn();
    const malformed = await handleReviewerReviewGet(
      "not-a-uuid",
      REVIEWER,
      CONFIG,
      noFetch,
    );
    expect(noFetch).not.toHaveBeenCalled();

    const missing = await handleReviewerReviewGet(
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      vi.fn(async () => Response.json([])),
    );

    for (const response of [malformed, missing]) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: "not_found", message: "Not found" },
      });
    }
  });

  it("fails closed when related data crosses an ownership boundary", async () => {
    const response = await handleReviewerReviewGet(
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      detailFetcher({ decision: { user_id: OTHER_REVIEWER_ID } }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(OTHER_REVIEWER_ID);
  });
});

describe("reviewer decisions", () => {
  it("submits an approval transaction and returns the resolved Review", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/rpc/decide_reviewer_review")) {
          expect(JSON.parse(String(init?.body))).toEqual({
            p_review_id: REVIEW_ID,
            p_user_id: REVIEWER.id,
            p_expected_version: 1,
            p_outcome: "approved",
            p_comment: null,
          });
          return Response.json([decisionTransactionRow()]);
        }
        return new Response(null, { status: 404 });
      },
    );

    const response = await handleReviewerReviewDecision(
      decisionRequest({ expected_version: 1, outcome: "approved" }),
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      fetcher,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      review: {
        id: REVIEW_ID,
        status: "approved",
        version: 2,
        decision: { outcome: "approved", comment: null },
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("normalizes required changes-requested feedback before persistence", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/rpc/decide_reviewer_review")) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            p_outcome: "changes_requested",
            p_comment: "Show the expanded menu.",
          });
          return Response.json([
            decisionTransactionRow({
              status: "changes_requested",
              outcome: "changes_requested",
              comment: "Show the expanded menu.",
            }),
          ]);
        }
        return new Response(null, { status: 404 });
      },
    );

    const response = await handleReviewerReviewDecision(
      decisionRequest({
        expected_version: 1,
        outcome: "changes_requested",
        comment: "  Show the expanded menu.  ",
      }),
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      fetcher,
    );

    expect(response.status).toBe(200);
  });

  it("rejects invalid decisions before contacting Postgres", async () => {
    const fetcher = vi.fn();
    const response = await handleReviewerReviewDecision(
      decisionRequest({ expected_version: 1, outcome: "changes_requested" }),
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      fetcher,
    );

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a conflict for stale, repeated, or terminal decisions", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { code: "P0001", message: "review decision conflict" },
        { status: 400 },
      ),
    );
    const response = await handleReviewerReviewDecision(
      decisionRequest({ expected_version: 1, outcome: "approved" }),
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      fetcher,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "conflict", message: "Review conflict" },
    });
  });

  it("makes missing and foreign Reviews indistinguishable", async () => {
    const response = await handleReviewerReviewDecision(
      decisionRequest({ expected_version: 1, outcome: "approved" }),
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      vi.fn(async () => Response.json([])),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Not found" },
    });
  });

  it("fails closed for malformed transaction responses", async () => {
    const response = await handleReviewerReviewDecision(
      decisionRequest({ expected_version: 1, outcome: "approved" }),
      REVIEW_ID,
      REVIEWER,
      CONFIG,
      vi.fn(async () =>
        Response.json([{ review_id: REVIEW_ID, status: "approved" }]),
      ),
    );

    expect(response.status).toBe(503);
  });
});
