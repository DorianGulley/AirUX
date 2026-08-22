import { describe, expect, it, vi } from "vitest";

import { deleteStreamVideo } from "../src/stream-video-deletion.js";

const STREAM_NOT_FOUND_MESSAGE =
  "Not Found: The requested resource or operation was not found.";

function streamError(name: string, statusCode: number) {
  return Object.assign(new Error("private provider detail"), {
    name,
    statusCode,
  });
}

describe("Stream video deletion", () => {
  it("resolves after deleting an existing video", async () => {
    const video = { delete: vi.fn(async () => undefined) };

    await expect(deleteStreamVideo(video)).resolves.toBeUndefined();
    expect(video.delete).toHaveBeenCalledOnce();
  });

  it("treats an already-missing video as deleted", async () => {
    const video = {
      delete: vi.fn(async () => {
        throw streamError("NotFoundError", 404);
      }),
    };

    await expect(deleteStreamVideo(video)).resolves.toBeUndefined();
  });

  it("accepts the plain missing-video error emitted by the live binding", async () => {
    const video = {
      delete: vi.fn(async () => {
        throw new Error(STREAM_NOT_FOUND_MESSAGE);
      }),
    };

    await expect(deleteStreamVideo(video)).resolves.toBeUndefined();
  });

  it.each([
    streamError("InternalError", 500),
    streamError("NotFoundError", 503),
    new Error("private provider detail"),
    new Error(`${STREAM_NOT_FOUND_MESSAGE} private suffix`),
    "non-error rejection",
  ])("preserves retryable provider failures", async (error) => {
    const video = {
      delete: vi.fn(async () => {
        throw error;
      }),
    };

    await expect(deleteStreamVideo(video)).rejects.toBe(error);
  });
});
