import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  runScheduledCleanup,
  ScheduledCleanupError,
} from "../src/scheduled-cleanup.js";
import { TEST_ENV } from "./fixtures.js";

const CONFIG = loadConfig(TEST_ENV);
const NOW = new Date("2026-08-22T04:30:00.000Z");
const FIRST_EVIDENCE_ID = "347a6473-e510-4d6a-918f-b2bd56d942b7";
const SECOND_EVIDENCE_ID = "447a6473-e510-4d6a-918f-b2bd56d942b7";
const FIRST_REVIEW_ID = "8d4ddde8-b58f-4c2c-b37f-b3ea1fb312da";
const SECOND_REVIEW_ID = "9d4ddde8-b58f-4c2c-b37f-b3ea1fb312da";

function dueRows() {
  return [
    {
      evidence_id: FIRST_EVIDENCE_ID,
      review_id: FIRST_REVIEW_ID,
      stream_video_id: "due-stream-video",
      evidence_status: "deleting",
      review_status: "expired",
    },
    {
      evidence_id: SECOND_EVIDENCE_ID,
      review_id: SECOND_REVIEW_ID,
      stream_video_id: null,
      evidence_status: "deleting",
      review_status: "cancelled",
    },
  ];
}

function completionRow(evidenceId: string, reviewId: string) {
  return {
    evidence_id: evidenceId,
    review_id: reviewId,
    status: "deleted",
    deleted_at: "2026-08-22T04:30:01.000Z",
  };
}

describe("scheduled Evidence cleanup", () => {
  it("deletes a bounded due batch and records every successful result", async () => {
    const completed: string[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body));
        expect(init).toMatchObject({ method: "POST", redirect: "manual" });
        expect(new Headers(init?.headers).get("apikey")).toBe(
          TEST_ENV.SUPABASE_SECRET_KEY,
        );
        if (url.pathname.endsWith("/rpc/prepare_due_evidence_cleanup")) {
          expect(body).toEqual({
            p_due_before: NOW.toISOString(),
            p_limit: 25,
          });
          return Response.json(dueRows());
        }
        if (url.pathname.endsWith("/rpc/complete_evidence_cleanup")) {
          completed.push(body.p_evidence_id);
          if (body.p_evidence_id === FIRST_EVIDENCE_ID) {
            expect(body.p_stream_video_id).toBe("due-stream-video");
            return Response.json([
              completionRow(FIRST_EVIDENCE_ID, FIRST_REVIEW_ID),
            ]);
          }
          expect(body.p_stream_video_id).toBeNull();
          return Response.json([
            completionRow(SECOND_EVIDENCE_ID, SECOND_REVIEW_ID),
          ]);
        }
        return new Response(null, { status: 404 });
      },
    );
    const stream = { deleteVideo: vi.fn(async () => undefined) };

    await expect(
      runScheduledCleanup(CONFIG, { fetcher, stream }, NOW),
    ).resolves.toEqual({ selected: 2, deleted: 2 });

    expect(stream.deleteVideo).toHaveBeenCalledExactlyOnceWith(
      "due-stream-video",
    );
    expect(completed).toEqual([FIRST_EVIDENCE_ID, SECOND_EVIDENCE_ID]);
  });

  it("continues the batch but leaves failed provider deletion unrecorded", async () => {
    const completed: string[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/rpc/prepare_due_evidence_cleanup")) {
          return Response.json(dueRows());
        }
        const body = JSON.parse(String(init?.body));
        completed.push(body.p_evidence_id);
        return Response.json([
          completionRow(SECOND_EVIDENCE_ID, SECOND_REVIEW_ID),
        ]);
      },
    );
    const stream = {
      deleteVideo: vi.fn(async () => {
        throw new Error("private provider failure");
      }),
    };

    await expect(
      runScheduledCleanup(CONFIG, { fetcher, stream }, NOW),
    ).rejects.toEqual(
      new ScheduledCleanupError({ selected: 2, deleted: 1, failed: 1 }),
    );
    expect(completed).toEqual([SECOND_EVIDENCE_ID]);
  });

  it("fails closed on malformed database work without touching Stream", async () => {
    const stream = { deleteVideo: vi.fn() };
    const fetcher = vi.fn(async () =>
      Response.json([
        {
          ...dueRows()[0],
          review_status: "pending",
        },
      ]),
    );

    await expect(
      runScheduledCleanup(CONFIG, { fetcher, stream }, NOW),
    ).rejects.toEqual(new ScheduledCleanupError());
    expect(stream.deleteVideo).not.toHaveBeenCalled();
  });

  it("rejects an invalid cleanup clock before querying Postgres", async () => {
    const fetcher = vi.fn();
    await expect(
      runScheduledCleanup(
        CONFIG,
        { fetcher, stream: { deleteVideo: vi.fn() } },
        new Date(Number.NaN),
      ),
    ).rejects.toEqual(new ScheduledCleanupError());
    expect(fetcher).not.toHaveBeenCalled();
  });
});
