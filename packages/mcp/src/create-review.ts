import {
  type AgentReview,
  type CapturePlan,
  type CreateReviewRequest,
  type CreateReviewResponse,
  type CreateReviewToolOutput,
  createReviewToolInputSchema,
  createReviewToolOutputSchema,
  getAgentReviewResponseSchema,
} from "@airux/shared/v1";

import { AiruxApiError } from "./api-client.js";
import {
  recordBrowserVideo,
  type TemporaryBrowserRecording,
} from "./browser-recording.js";
import {
  type DirectUploadDependencies,
  DirectUploadError,
  uploadBrowserRecording,
  waitForBrowserRecordingProcessing,
} from "./direct-upload.js";

const MAX_API_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;

export interface AiruxReviewApi {
  createReview(
    request: CreateReviewRequest,
    signal: AbortSignal,
  ): Promise<CreateReviewResponse>;
  getReview(reviewId: string, signal: AbortSignal): Promise<unknown>;
}

export interface CreateReviewWorkflowDependencies {
  readonly api: AiruxReviewApi;
  readonly capture?: (plan: CapturePlan) => Promise<TemporaryBrowserRecording>;
  readonly directUploadDependencies?: Omit<
    DirectUploadDependencies,
    "getReview" | "signal"
  >;
  readonly resumeProcessing?: typeof waitForBrowserRecordingProcessing;
  readonly sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  readonly upload?: typeof uploadBrowserRecording;
}

export class CreateReviewWorkflowError extends Error {
  readonly stage: "capture" | "create" | "upload" | "processing" | "cleanup";

  constructor(
    stage: CreateReviewWorkflowError["stage"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CreateReviewWorkflowError";
    this.stage = stage;
  }
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

async function callWithTransientRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  sleep: (durationMs: number, signal: AbortSignal) => Promise<void>,
) {
  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof AiruxApiError) ||
        !error.retryable ||
        attempt === MAX_API_ATTEMPTS
      ) {
        throw error;
      }
      await sleep(
        Math.min(
          error.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS,
          MAX_RETRY_DELAY_MS,
        ),
        signal,
      );
    }
  }
  throw new Error("Unreachable retry state");
}

function validateReviewForAssignment(
  value: unknown,
  assignment: CreateReviewResponse,
) {
  const parsed = getAgentReviewResponseSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.review.id !== assignment.review_id ||
    parsed.data.review.evidence.id !== assignment.evidence_id
  ) {
    throw new CreateReviewWorkflowError(
      "processing",
      "AirUX returned an invalid recovery status",
    );
  }
  return parsed.data.review;
}

function pendingOutput(review: AgentReview): CreateReviewToolOutput {
  if (review.status !== "pending" || review.evidence.status !== "ready") {
    throw new CreateReviewWorkflowError(
      "processing",
      "The review did not reach the pending state",
    );
  }
  return createReviewToolOutputSchema.parse({
    review_id: review.id,
    review_url: review.review_url,
    status: "pending",
  });
}

async function bestEffortDelete(recording: TemporaryBrowserRecording) {
  try {
    await recording.delete();
  } catch {
    // The workflow error remains authoritative after best-effort cleanup.
  }
}

async function deleteAfterProcessing(recording: TemporaryBrowserRecording) {
  try {
    await recording.delete();
  } catch (error) {
    throw new CreateReviewWorkflowError(
      "cleanup",
      "The processed browser recording could not be removed",
      { cause: error },
    );
  }
}

export async function createAiruxReview(
  input: unknown,
  dependencies: CreateReviewWorkflowDependencies,
  signal: AbortSignal = new AbortController().signal,
) {
  const parsed = createReviewToolInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CreateReviewWorkflowError("capture", "Invalid tool input");
  }

  const sleep = dependencies.sleep ?? defaultSleep;
  const capture = dependencies.capture ?? recordBrowserVideo;
  const upload = dependencies.upload ?? uploadBrowserRecording;
  const resume =
    dependencies.resumeProcessing ?? waitForBrowserRecordingProcessing;
  let recording: TemporaryBrowserRecording | undefined;

  try {
    recording = await capture(parsed.data.capture_plan);
    const request: CreateReviewRequest = {
      claim: parsed.data.claim,
      client_request_id: parsed.data.client_request_id,
      criteria: parsed.data.criteria,
      evidence: {
        kind: "browser_video",
        media_type: recording.mediaType,
        size_bytes: recording.sizeBytes,
      },
      title: parsed.data.title,
    };
    const create = () =>
      callWithTransientRetry(
        () => dependencies.api.createReview(request, signal),
        signal,
        sleep,
      );
    let assignment = await create();
    const uploadDependencies: DirectUploadDependencies = {
      ...dependencies.directUploadDependencies,
      getReview: (reviewId, reviewSignal) =>
        dependencies.api.getReview(reviewId, reviewSignal),
      signal,
    };

    let review: AgentReview;
    try {
      review = await upload(recording, assignment, uploadDependencies);
    } catch (error) {
      if (
        !(error instanceof DirectUploadError) ||
        (error.stage !== "upload" && error.stage !== "confirmation")
      ) {
        throw error;
      }

      const recoveryValue = await callWithTransientRetry(
        () => dependencies.api.getReview(assignment.review_id, signal),
        signal,
        sleep,
      );
      const recoveryReview = validateReviewForAssignment(
        recoveryValue,
        assignment,
      );
      if (recoveryReview.evidence.status === "ready") {
        await deleteAfterProcessing(recording);
        review = recoveryReview;
      } else if (recoveryReview.evidence.status === "processing") {
        review = await resume(assignment, uploadDependencies);
        await deleteAfterProcessing(recording);
      } else if (recoveryReview.evidence.status === "awaiting_upload") {
        assignment = await create();
        review = await upload(recording, assignment, uploadDependencies);
      } else {
        throw new CreateReviewWorkflowError(
          "processing",
          "The browser recording could not be processed",
        );
      }
    }

    return pendingOutput(review);
  } catch (error) {
    if (recording !== undefined) {
      await bestEffortDelete(recording);
    }
    if (error instanceof CreateReviewWorkflowError) {
      throw error;
    }
    const stage =
      recording === undefined
        ? "capture"
        : error instanceof AiruxApiError
          ? "create"
          : error instanceof DirectUploadError && error.stage === "cleanup"
            ? "cleanup"
            : error instanceof DirectUploadError && error.stage === "processing"
              ? "processing"
              : "upload";
    throw new CreateReviewWorkflowError(
      stage,
      "The AirUX review workflow did not complete",
      { cause: error },
    );
  }
}
