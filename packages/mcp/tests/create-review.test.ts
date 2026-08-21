import { describe, expect, it, vi } from "vitest";

import { AiruxApiError } from "../src/api-client.js";
import { TemporaryBrowserRecording } from "../src/browser-recording.js";
import {
  CreateReviewWorkflowError,
  createAiruxReview,
} from "../src/create-review.js";
import { DirectUploadError } from "../src/direct-upload.js";

const REVIEW_ID = "20000000-0000-4000-8000-000000000045";
const EVIDENCE_ID = "30000000-0000-4000-8000-000000000045";
const input = {
  capture_plan: {
    max_duration_ms: 30_000,
    start_url: "http://localhost:3000",
    steps: [{ action: "pause" as const, duration_ms: 250 }],
    viewport: { height: 720, width: 1_280 },
  },
  claim: "The flow works.",
  client_request_id: "agent-run-45",
  criteria: [{ id: "works", prompt: "The flow completes." }],
  title: "Review the flow",
};
const assignment = {
  evidence_id: EVIDENCE_ID,
  review_id: REVIEW_ID,
  review_url: `https://airux.example/reviews/${REVIEW_ID}`,
  status: "draft" as const,
  upload_expires_at: "2026-08-20T22:15:00.000Z",
  upload_url: "https://upload.videodelivery.net/token",
};

function review(evidenceStatus: "awaiting_upload" | "processing" | "ready") {
  const ready = evidenceStatus === "ready";
  return {
    claim: input.claim,
    client_request_id: input.client_request_id,
    created_at: "2026-08-20T22:00:00.000Z",
    criteria: input.criteria,
    decision: null,
    evidence: {
      failure_code: null,
      id: EVIDENCE_ID,
      kind: "browser_video" as const,
      media_type: "video/webm",
      size_bytes: 5,
      status: evidenceStatus,
    },
    expires_at: "2026-08-20T23:00:00.000Z",
    id: REVIEW_ID,
    resolved_at: null,
    review_url: assignment.review_url,
    status: ready ? ("pending" as const) : ("draft" as const),
    submitted_at: ready ? "2026-08-20T22:00:10.000Z" : null,
    title: input.title,
    version: ready ? 1 : 0,
  };
}

function recording() {
  const remove = vi.fn(async () => {});
  return {
    artifact: new TemporaryBrowserRecording(
      {
        directory: "/tmp/airux-create-review",
        filePath: "/tmp/airux-create-review/capture.webm",
        height: 720,
        sizeBytes: 5,
        width: 1_280,
      },
      remove,
    ),
    remove,
  };
}

describe("createAiruxReview", () => {
  it("captures once, derives evidence metadata, and returns a pending handoff", async () => {
    const { artifact, remove } = recording();
    const capture = vi.fn(async () => artifact);
    const api = {
      createReview: vi.fn(async () => assignment),
      getReview: vi.fn(),
    };
    const upload = vi.fn(async () => {
      await artifact.delete();
      return review("ready");
    });

    await expect(
      createAiruxReview(input, { api, capture, upload }),
    ).resolves.toEqual({
      review_id: REVIEW_ID,
      review_url: assignment.review_url,
      status: "pending",
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(api.createReview).toHaveBeenCalledWith(
      {
        claim: input.claim,
        client_request_id: input.client_request_id,
        criteria: input.criteria,
        evidence: {
          kind: "browser_video",
          media_type: "video/webm",
          size_bytes: 5,
        },
        title: input.title,
      },
      expect.any(AbortSignal),
    );
    expect(upload).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("retries transient creation with the same idempotent payload", async () => {
    const { artifact } = recording();
    const api = {
      createReview: vi
        .fn()
        .mockRejectedValueOnce(
          new AiruxApiError("offline", { retryable: true }),
        )
        .mockResolvedValueOnce(assignment),
      getReview: vi.fn(),
    };
    const sleep = vi.fn(async () => {});
    const upload = vi.fn(async () => review("ready"));

    await createAiruxReview(input, {
      api,
      capture: vi.fn(async () => artifact),
      sleep,
      upload,
    });

    expect(api.createReview).toHaveBeenCalledTimes(2);
    expect(api.createReview.mock.calls[0]?.[0]).toEqual(
      api.createReview.mock.calls[1]?.[0],
    );
    expect(sleep).toHaveBeenCalledWith(250, expect.any(AbortSignal));
  });

  it("refreshes the upload slot once after an ambiguous awaiting-upload result", async () => {
    const { artifact, remove } = recording();
    const api = {
      createReview: vi.fn(async () => assignment),
      getReview: vi.fn(async () => ({ review: review("awaiting_upload") })),
    };
    const upload = vi
      .fn()
      .mockRejectedValueOnce(
        new DirectUploadError("upload", "connection closed"),
      )
      .mockImplementationOnce(async () => {
        await artifact.delete();
        return review("ready");
      });

    await expect(
      createAiruxReview(input, {
        api,
        capture: vi.fn(async () => artifact),
        upload,
      }),
    ).resolves.toMatchObject({ review_id: REVIEW_ID, status: "pending" });
    expect(api.createReview).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("resumes polling without uploading again when Stream is processing", async () => {
    const { artifact, remove } = recording();
    const api = {
      createReview: vi.fn(async () => assignment),
      getReview: vi.fn(async () => ({ review: review("processing") })),
    };
    const upload = vi.fn(async () => {
      throw new DirectUploadError("confirmation", "status unavailable");
    });
    const resumeProcessing = vi.fn(async () => review("ready"));

    await createAiruxReview(input, {
      api,
      capture: vi.fn(async () => artifact),
      resumeProcessing,
      upload,
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(resumeProcessing).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("deletes the recording after recovery is exhausted", async () => {
    const { artifact, remove } = recording();
    const api = {
      createReview: vi.fn(async () => assignment),
      getReview: vi.fn(async () => {
        throw new AiruxApiError("still offline", { retryable: true });
      }),
    };
    const upload = vi.fn(async () => {
      throw new DirectUploadError("upload", "secret provider detail");
    });

    let error: unknown;
    try {
      await createAiruxReview(input, {
        api,
        capture: vi.fn(async () => artifact),
        sleep: vi.fn(async () => {}),
        upload,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CreateReviewWorkflowError);
    expect(String(error)).not.toContain("secret provider detail");
    expect(api.getReview).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
  });
});
