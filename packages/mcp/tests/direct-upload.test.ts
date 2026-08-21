import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TemporaryBrowserRecording } from "../src/browser-recording.js";
import {
  type DirectUploadDependencies,
  DirectUploadError,
  uploadBrowserRecording,
} from "../src/direct-upload.js";

const NOW = new Date("2026-08-20T22:00:00.000Z");
const REVIEW_ID = "20000000-0000-4000-8000-000000000045";
const EVIDENCE_ID = "30000000-0000-4000-8000-000000000045";

const assignment = {
  review_id: REVIEW_ID,
  review_url: `https://airux.example/reviews/${REVIEW_ID}`,
  status: "draft",
  evidence_id: EVIDENCE_ID,
  upload_url: "https://upload.videodelivery.net/one-time-token",
  upload_expires_at: "2026-08-20T22:15:00.000Z",
};

function reviewResponse(
  evidenceStatus:
    | "awaiting_upload"
    | "processing"
    | "ready"
    | "failed"
    | "deleting"
    | "deleted",
  overrides: {
    evidenceId?: string;
    reviewId?: string;
  } = {},
) {
  const ready = evidenceStatus === "ready";
  return {
    review: {
      id: overrides.reviewId ?? REVIEW_ID,
      review_url: `https://airux.example/reviews/${REVIEW_ID}`,
      client_request_id: "direct-upload-test",
      title: "Direct upload",
      claim: "The recording uploads directly to Stream.",
      criteria: [{ id: "upload", prompt: "The recording is ready." }],
      status: ready ? "pending" : "draft",
      version: ready ? 1 : 0,
      created_at: "2026-08-20T22:00:00.000Z",
      submitted_at: ready ? "2026-08-20T22:00:10.000Z" : null,
      expires_at: "2026-08-20T23:00:00.000Z",
      resolved_at: null,
      evidence: {
        id: overrides.evidenceId ?? EVIDENCE_ID,
        kind: "browser_video",
        status: evidenceStatus,
        media_type: "video/webm",
        size_bytes: 5,
        failure_code:
          evidenceStatus === "failed" ? "ERR_MALFORMED_VIDEO" : null,
      },
      decision: null,
    },
  };
}

function recording(
  removeDirectory = vi.fn(async (_path: string) => {}),
  sizeBytes = 5,
) {
  return {
    recording: new TemporaryBrowserRecording(
      {
        directory: "/tmp/airux-direct-upload",
        filePath: "/tmp/airux-direct-upload/capture.webm",
        height: 720,
        sizeBytes,
        width: 1_280,
      },
      removeDirectory,
    ),
    removeDirectory,
  };
}

function dependencies(getReview = vi.fn(async () => reviewResponse("ready"))) {
  return {
    fetcher: vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    ),
    getReview,
    now: vi.fn(() => NOW),
    openFile: vi.fn(async () => new Blob(["video"], { type: "video/webm" })),
    sleep: vi.fn(async (_durationMs: number, _signal: AbortSignal) => {}),
  };
}

describe("uploadBrowserRecording", () => {
  it("uploads the file directly and deletes it only after processing succeeds", async () => {
    const { recording: artifact, removeDirectory } = recording();
    const getReview = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect(removeDirectory).not.toHaveBeenCalled();
        return reviewResponse("awaiting_upload");
      })
      .mockImplementationOnce(async () => {
        expect(removeDirectory).not.toHaveBeenCalled();
        return reviewResponse("processing");
      })
      .mockImplementationOnce(async () => {
        expect(removeDirectory).not.toHaveBeenCalled();
        return reviewResponse("ready");
      });
    const uploadDependencies = dependencies(getReview);

    const review = await uploadBrowserRecording(
      artifact,
      assignment,
      uploadDependencies,
    );

    expect(review.evidence.status).toBe("ready");
    expect(uploadDependencies.openFile).toHaveBeenCalledWith(
      artifact.filePath,
      "video/webm",
    );
    expect(uploadDependencies.fetcher).toHaveBeenCalledOnce();
    const [url, init] = uploadDependencies.fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(assignment.upload_url);
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init?.headers).toBeUndefined();
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) {
      throw new Error("Expected a multipart upload body");
    }
    const file = body.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect(file).toMatchObject({
      name: "capture.webm",
      size: 5,
      type: "video/webm",
    });
    expect(uploadDependencies.sleep.mock.calls.map(([delay]) => delay)).toEqual(
      [1_000, 2_000],
    );
    expect(getReview).toHaveBeenCalledWith(REVIEW_ID, expect.any(AbortSignal));
    expect(removeDirectory).toHaveBeenCalledOnce();
    expect(removeDirectory).toHaveBeenCalledWith("/tmp/airux-direct-upload");
  });

  it("streams a file-backed Blob as a multipart file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "airux-upload-test-"));
    const filePath = join(directory, "capture.webm");
    await writeFile(filePath, "video");
    const artifact = new TemporaryBrowserRecording(
      {
        directory,
        filePath,
        height: 720,
        sizeBytes: 5,
        width: 1_280,
      },
      (path) => rm(path, { force: true, recursive: true }),
    );
    const testDependencies = dependencies();
    const uploadDependencies: DirectUploadDependencies = {
      fetcher: testDependencies.fetcher,
      getReview: testDependencies.getReview,
      now: testDependencies.now,
      sleep: testDependencies.sleep,
    };
    testDependencies.fetcher.mockImplementationOnce(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("content-type")).toMatch(
        /^multipart\/form-data; boundary=/,
      );
      const form = await request.formData();
      const file = form.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect(file).toMatchObject({
        name: "capture.webm",
        size: 5,
        type: "video/webm",
      });
      await expect((file as Blob).text()).resolves.toBe("video");
      return new Response(null, { status: 200 });
    });

    try {
      await uploadBrowserRecording(artifact, assignment, uploadDependencies);
      await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    "http://upload.videodelivery.net/token",
    "https://example.com/token",
    "https://upload.videodelivery.net.evil.example/token",
    "https://user@upload.videodelivery.net/token",
    "https://upload.videodelivery.net/#token",
  ])("rejects an untrusted upload destination: %s", async (uploadUrl) => {
    const { recording: artifact, removeDirectory } = recording();
    const uploadDependencies = dependencies();

    await expect(
      uploadBrowserRecording(
        artifact,
        { ...assignment, upload_url: uploadUrl },
        uploadDependencies,
      ),
    ).rejects.toMatchObject({
      name: "DirectUploadError",
      stage: "validation",
    });
    expect(uploadDependencies.openFile).not.toHaveBeenCalled();
    expect(uploadDependencies.fetcher).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("rejects an expired upload assignment before opening the recording", async () => {
    const { recording: artifact, removeDirectory } = recording();
    const uploadDependencies = dependencies();

    await expect(
      uploadBrowserRecording(
        artifact,
        { ...assignment, upload_expires_at: NOW.toISOString() },
        uploadDependencies,
      ),
    ).rejects.toMatchObject({ stage: "validation" });
    expect(uploadDependencies.openFile).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("preserves a recording that changed before upload", async () => {
    const { recording: artifact, removeDirectory } = recording();
    const uploadDependencies = dependencies();
    uploadDependencies.openFile.mockResolvedValueOnce(
      new Blob(["different"], { type: "video/webm" }),
    );

    await expect(
      uploadBrowserRecording(artifact, assignment, uploadDependencies),
    ).rejects.toMatchObject({ stage: "upload" });
    expect(uploadDependencies.fetcher).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("preserves a recording after a network failure", async () => {
    const { recording: artifact, removeDirectory } = recording();
    const uploadDependencies = dependencies();
    uploadDependencies.fetcher.mockRejectedValueOnce(new Error("offline"));

    await expect(
      uploadBrowserRecording(artifact, assignment, uploadDependencies),
    ).rejects.toMatchObject({ stage: "upload" });
    expect(uploadDependencies.getReview).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("preserves a recording rejected by Stream", async () => {
    const { recording: artifact, removeDirectory } = recording();
    const uploadDependencies = dependencies();
    uploadDependencies.fetcher.mockResolvedValueOnce(
      new Response("rejected", { status: 400 }),
    );

    await expect(
      uploadBrowserRecording(artifact, assignment, uploadDependencies),
    ).rejects.toMatchObject({ stage: "upload" });
    expect(uploadDependencies.getReview).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("preserves a recording when Stream processing fails", async () => {
    const { recording: artifact, removeDirectory } = recording();
    const uploadDependencies = dependencies(
      vi.fn(async () => reviewResponse("failed")),
    );

    await expect(
      uploadBrowserRecording(artifact, assignment, uploadDependencies),
    ).rejects.toMatchObject({ stage: "processing" });
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("rejects a processing status for another Evidence record", async () => {
    const { recording: artifact, removeDirectory } = recording();
    const uploadDependencies = dependencies(
      vi.fn(async () =>
        reviewResponse("ready", {
          evidenceId: "30000000-0000-4000-8000-000000000099",
        }),
      ),
    );

    await expect(
      uploadBrowserRecording(artifact, assignment, uploadDependencies),
    ).rejects.toMatchObject({ stage: "confirmation" });
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("uses a five-minute confirmation deadline", async () => {
    const { recording: artifact, removeDirectory } = recording();
    let now = NOW;
    const uploadDependencies = dependencies(
      vi.fn(async () => reviewResponse("processing")),
    );
    uploadDependencies.now.mockImplementation(() => now);
    uploadDependencies.sleep.mockImplementationOnce(async () => {
      now = new Date(NOW.getTime() + 5 * 60 * 1000);
    });

    await expect(
      uploadBrowserRecording(artifact, assignment, uploadDependencies),
    ).rejects.toMatchObject({
      stage: "confirmation",
      message: "Timed out waiting for Stream processing",
    });
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("surfaces cleanup failure after processing confirmation", async () => {
    const cleanupFailure = new Error("filesystem busy");
    const { recording: artifact } = recording(
      vi.fn(async () => {
        throw cleanupFailure;
      }),
    );
    const uploadDependencies = dependencies();

    await expect(
      uploadBrowserRecording(artifact, assignment, uploadDependencies),
    ).rejects.toEqual(
      new DirectUploadError(
        "cleanup",
        "Stream processing succeeded but the local recording could not be removed",
        { cause: cleanupFailure },
      ),
    );
  });
});
