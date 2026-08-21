import { openAsBlob } from "node:fs";
import { basename } from "node:path";

import {
  type AgentReview,
  CONTRACT_LIMITS,
  type CreateReviewResponse,
  createReviewResponseSchema,
  getAgentReviewResponseSchema,
} from "@airux/shared/v1";

import type { TemporaryBrowserRecording } from "./browser-recording.js";

const STREAM_UPLOAD_ORIGINS = new Set([
  "https://upload.cloudflarestream.com",
  "https://upload.videodelivery.net",
]);
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const INITIAL_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 10_000;

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DirectUploadStage =
  | "validation"
  | "upload"
  | "confirmation"
  | "processing"
  | "cleanup";

export interface DirectUploadDependencies {
  readonly fetcher?: Fetcher;
  readonly getReview: (
    reviewId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly now?: () => Date;
  readonly openFile?: (path: string, mediaType: string) => Promise<Blob>;
  readonly signal?: AbortSignal;
  readonly sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
}

export class DirectUploadError extends Error {
  readonly stage: DirectUploadStage;

  constructor(
    stage: DirectUploadStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DirectUploadError";
    this.stage = stage;
  }
}

function currentTime(now: () => Date) {
  const value = now();
  if (Number.isNaN(value.getTime())) {
    throw new DirectUploadError("validation", "Invalid system time");
  }
  return value;
}

function validateUpload(
  input: unknown,
  recording: TemporaryBrowserRecording,
  now: Date,
) {
  const parsed = createReviewResponseSchema.safeParse(input);
  if (!parsed.success) {
    throw new DirectUploadError(
      "validation",
      "Invalid Stream direct-upload assignment",
    );
  }

  const uploadUrl = new URL(parsed.data.upload_url);
  if (
    !STREAM_UPLOAD_ORIGINS.has(uploadUrl.origin) ||
    uploadUrl.username.length > 0 ||
    uploadUrl.password.length > 0 ||
    uploadUrl.hash.length > 0 ||
    uploadUrl.pathname === "/"
  ) {
    throw new DirectUploadError(
      "validation",
      "Invalid Stream direct-upload destination",
    );
  }

  const expiresAt = new Date(parsed.data.upload_expires_at);
  if (expiresAt.getTime() <= now.getTime()) {
    throw new DirectUploadError(
      "validation",
      "Stream direct-upload assignment has expired",
    );
  }

  if (
    !Number.isSafeInteger(recording.sizeBytes) ||
    recording.sizeBytes < 1 ||
    recording.sizeBytes > CONTRACT_LIMITS.mediaSizeBytes
  ) {
    throw new DirectUploadError(
      "validation",
      "Browser recording is outside the supported size limit",
    );
  }

  return {
    assignment: parsed.data,
    expiresAt,
    uploadUrl,
  };
}

function defaultOpenFile(path: string, mediaType: string) {
  return openAsBlob(path, { type: mediaType });
}

function defaultSleep(durationMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The upload result is authoritative even if response cleanup fails.
  }
}

async function uploadRecording(
  recording: TemporaryBrowserRecording,
  uploadUrl: URL,
  expiresAt: Date,
  now: Date,
  fetcher: Fetcher,
  openFile: (path: string, mediaType: string) => Promise<Blob>,
  signal?: AbortSignal,
) {
  let file: Blob;
  try {
    file = await openFile(recording.filePath, recording.mediaType);
  } catch (error) {
    throw new DirectUploadError(
      "upload",
      "Could not open the browser recording for upload",
      { cause: error },
    );
  }
  if (file.size !== recording.sizeBytes) {
    throw new DirectUploadError(
      "upload",
      "Browser recording changed before upload",
    );
  }

  const body = new FormData();
  body.set("file", file, basename(recording.filePath));
  const controller = new AbortController();
  const uploadSignal =
    signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, signal]);
  const expiryTimer = setTimeout(
    () => controller.abort(),
    expiresAt.getTime() - now.getTime(),
  );

  let response: Response;
  try {
    response = await fetcher(uploadUrl, {
      method: "POST",
      body,
      redirect: "manual",
      signal: uploadSignal,
    });
  } catch (error) {
    throw new DirectUploadError("upload", "Stream direct upload failed", {
      cause: error,
    });
  } finally {
    clearTimeout(expiryTimer);
  }

  await cancelResponseBody(response);
  if (response.status !== 200) {
    throw new DirectUploadError("upload", "Stream rejected the direct upload");
  }
}

function confirmedReview(
  value: unknown,
  assignment: CreateReviewResponse,
): AgentReview {
  const parsed = getAgentReviewResponseSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.review.id !== assignment.review_id ||
    parsed.data.review.evidence.id !== assignment.evidence_id
  ) {
    throw new DirectUploadError(
      "confirmation",
      "AirUX returned an invalid processing status",
    );
  }
  return parsed.data.review;
}

async function waitForProcessing(
  assignment: CreateReviewResponse,
  dependencies: DirectUploadDependencies,
  now: () => Date,
) {
  const sleep = dependencies.sleep ?? defaultSleep;
  const controller = new AbortController();
  const signal =
    dependencies.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, dependencies.signal]);
  const startedAt = currentTime(now).getTime();
  const deadline = startedAt + PROCESSING_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), PROCESSING_TIMEOUT_MS);
  let delay = INITIAL_POLL_DELAY_MS;

  try {
    while (true) {
      let value: unknown;
      try {
        value = await dependencies.getReview(assignment.review_id, signal);
      } catch (error) {
        if (signal.aborted || currentTime(now).getTime() >= deadline) {
          throw new DirectUploadError(
            "confirmation",
            "Timed out waiting for Stream processing",
            { cause: error },
          );
        }
        throw new DirectUploadError(
          "confirmation",
          "Could not confirm Stream processing",
          { cause: error },
        );
      }

      const review = confirmedReview(value, assignment);
      if (review.evidence.status === "ready") {
        return review;
      }
      if (
        review.evidence.status === "failed" ||
        review.evidence.status === "deleting" ||
        review.evidence.status === "deleted"
      ) {
        throw new DirectUploadError(
          "processing",
          "Stream did not successfully process the browser recording",
        );
      }

      const remaining = deadline - currentTime(now).getTime();
      if (remaining <= 0) {
        throw new DirectUploadError(
          "confirmation",
          "Timed out waiting for Stream processing",
        );
      }
      try {
        await sleep(Math.min(delay, remaining), signal);
      } catch (error) {
        throw new DirectUploadError(
          "confirmation",
          "Timed out waiting for Stream processing",
          { cause: error },
        );
      }
      delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForBrowserRecordingProcessing(
  input: unknown,
  dependencies: DirectUploadDependencies,
) {
  const parsed = createReviewResponseSchema.safeParse(input);
  if (!parsed.success) {
    throw new DirectUploadError(
      "validation",
      "Invalid Stream direct-upload assignment",
    );
  }
  const now = dependencies.now ?? (() => new Date());
  return waitForProcessing(parsed.data, dependencies, now);
}

export async function uploadBrowserRecording(
  recording: TemporaryBrowserRecording,
  input: unknown,
  dependencies: DirectUploadDependencies,
) {
  const now = dependencies.now ?? (() => new Date());
  const current = currentTime(now);
  const { assignment, expiresAt, uploadUrl } = validateUpload(
    input,
    recording,
    current,
  );

  await uploadRecording(
    recording,
    uploadUrl,
    expiresAt,
    current,
    dependencies.fetcher ?? fetch,
    dependencies.openFile ?? defaultOpenFile,
    dependencies.signal,
  );
  const review = await waitForProcessing(assignment, dependencies, now);

  try {
    await recording.delete();
  } catch (error) {
    throw new DirectUploadError(
      "cleanup",
      "Stream processing succeeded but the local recording could not be removed",
      { cause: error },
    );
  }
  return review;
}
