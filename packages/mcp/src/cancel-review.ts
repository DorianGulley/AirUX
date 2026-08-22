import {
  cancelAgentReviewResponseSchema,
  cancelReviewToolInputSchema,
  cancelReviewToolOutputSchema,
} from "@airux/shared/v1";

import { AiruxApiError } from "./api-client.js";

const MAX_API_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;

export interface AiruxCancellationApi {
  cancelReview(reviewId: string, signal: AbortSignal): Promise<unknown>;
}

export interface CancelReviewWorkflowDependencies {
  readonly api: AiruxCancellationApi;
  readonly sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
}

export class CancelReviewWorkflowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CancelReviewWorkflowError";
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

export async function cancelAiruxReview(
  input: unknown,
  dependencies: CancelReviewWorkflowDependencies,
  signal: AbortSignal = new AbortController().signal,
) {
  const parsedInput = cancelReviewToolInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new CancelReviewWorkflowError("Invalid tool input");
  }

  const sleep = dependencies.sleep ?? defaultSleep;
  let response: unknown;
  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
    try {
      response = await dependencies.api.cancelReview(
        parsedInput.data.review_id,
        signal,
      );
      break;
    } catch (error) {
      if (
        !(error instanceof AiruxApiError) ||
        !error.retryable ||
        attempt === MAX_API_ATTEMPTS
      ) {
        throw new CancelReviewWorkflowError(
          "The AirUX Review could not be cancelled",
          { cause: error },
        );
      }
      try {
        await sleep(
          Math.min(
            error.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS,
            MAX_RETRY_DELAY_MS,
          ),
          signal,
        );
      } catch (sleepError) {
        throw new CancelReviewWorkflowError(
          "The AirUX Review cancellation was interrupted",
          { cause: sleepError },
        );
      }
    }
  }

  const parsedResponse = cancelAgentReviewResponseSchema.safeParse(response);
  if (
    !parsedResponse.success ||
    parsedResponse.data.review.id !== parsedInput.data.review_id ||
    parsedResponse.data.review.status !== "cancelled" ||
    !["deleting", "deleted"].includes(
      parsedResponse.data.review.evidence.status,
    )
  ) {
    throw new CancelReviewWorkflowError(
      "AirUX returned an invalid cancellation result",
    );
  }

  return cancelReviewToolOutputSchema.parse({
    review_id: parsedResponse.data.review.id,
    review_url: parsedResponse.data.review.review_url,
    status: parsedResponse.data.review.status,
  });
}
