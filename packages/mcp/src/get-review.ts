import {
  type AgentReview,
  type GetReviewToolOutput,
  getReviewToolInputSchema,
  getReviewToolOutputSchema,
} from "@airux/shared/v1";

import { AiruxApiError } from "./api-client.js";

const INITIAL_POLL_DELAY_MS = 2_000;
const MAX_POLL_DELAY_MS = 30_000;

export interface AiruxResultApi {
  getReviewForPolling(
    reviewId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly review: AgentReview;
    readonly retryAfterMs?: number;
  }>;
}

export interface GetReviewWorkflowDependencies {
  readonly api: AiruxResultApi;
  readonly sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
}

export class GetReviewWorkflowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GetReviewWorkflowError";
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

function terminalResult(review: AgentReview): GetReviewToolOutput | null {
  if (review.status === "draft" || review.status === "pending") {
    return null;
  }
  return getReviewToolOutputSchema.parse({
    review_id: review.id,
    review_url: review.review_url,
    status: review.status,
    decision: review.decision,
  });
}

export async function getAiruxReview(
  input: unknown,
  dependencies: GetReviewWorkflowDependencies,
  signal: AbortSignal = new AbortController().signal,
) {
  const parsed = getReviewToolInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new GetReviewWorkflowError("Invalid tool input");
  }

  const sleep = dependencies.sleep ?? defaultSleep;
  let delay = INITIAL_POLL_DELAY_MS;

  while (true) {
    let response: Awaited<ReturnType<AiruxResultApi["getReviewForPolling"]>>;
    try {
      response = await dependencies.api.getReviewForPolling(
        parsed.data.review_id,
        signal,
      );
    } catch (error) {
      if (!(error instanceof AiruxApiError) || !error.retryable) {
        throw new GetReviewWorkflowError(
          "The AirUX review result could not be retrieved",
          { cause: error },
        );
      }
      try {
        await sleep(Math.max(delay, error.retryAfterMs ?? 0), signal);
      } catch (sleepError) {
        throw new GetReviewWorkflowError("Review polling was interrupted", {
          cause: sleepError,
        });
      }
      delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
      continue;
    }

    if (response.review.id !== parsed.data.review_id) {
      throw new GetReviewWorkflowError(
        "AirUX returned an invalid review result",
      );
    }
    const result = terminalResult(response.review);
    if (result !== null) {
      return result;
    }

    try {
      await sleep(Math.max(delay, response.retryAfterMs ?? 0), signal);
    } catch (error) {
      throw new GetReviewWorkflowError("Review polling was interrupted", {
        cause: error,
      });
    }
    delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
  }
}
