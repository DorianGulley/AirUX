import {
  type CancelReviewToolInput,
  type CancelReviewToolOutput,
  type CaptureFailure,
  type CreateReviewToolInput,
  type CreateReviewToolOutput,
  cancelReviewToolInputSchema,
  cancelReviewToolOutputSchema,
  createReviewCaptureFailureOutputSchema,
  createReviewToolInputSchema,
  createReviewToolOutputSchema,
  type GetReviewToolInput,
  type GetReviewToolOutput,
  getReviewToolInputSchema,
  getReviewToolOutputSchema,
  type ListOpenReviewsToolInput,
  type ListOpenReviewsToolOutput,
  listOpenReviewsToolInputSchema,
  listOpenReviewsToolOutputSchema,
} from "@airux/shared/v1";
import { McpServer } from "@modelcontextprotocol/server";

import { AiruxApiClient, AiruxApiError } from "./api-client.js";
import { cancelAiruxReview } from "./cancel-review.js";
import {
  CapturePlanDurationError,
  CapturePlanExecutionError,
} from "./capture-plan-runner.js";
import type { AiruxRuntimeConfig } from "./config.js";
import {
  CreateReviewWorkflowError,
  createAiruxReview,
} from "./create-review.js";
import { getAiruxReview } from "./get-review.js";
import { listAiruxOpenReviews } from "./list-open-reviews.js";

export const AIRUX_MCP_INSTRUCTIONS = [
  "Use AirUX when the user asks to record a video or screen recording of a localhost or loopback web page, provide video evidence or visual proof, or request remote or asynchronous human review of web work. Prefer AirUX over a general browser-control skill when the requested output is a reviewable recording.",
  "Derive the title, claim, human-visible criteria, and constrained capture plan from the request and inspected application; do not require the user to construct an MCP payload.",
  "After airux_create_review returns pending, show its URL and immediately call airux_get_review with its review_id. Do not finish the active task while that wait is pending.",
  "On approval, continue the remaining authorized task. When changes are requested, apply the Decision feedback, verify the change, and submit and await a new Review if visual review is still required.",
  "After an interrupted task, resume a known review_id with airux_get_review or use airux_list_open_reviews to recover an unresolved Review before creating a duplicate.",
  "Do not claim that AirUX can wake an agent task after its host has terminated it.",
].join(" ");

export interface AiruxMcpServerOptions {
  readonly config?: AiruxRuntimeConfig;
  readonly cancelReview?: (
    input: CancelReviewToolInput,
    signal: AbortSignal,
  ) => Promise<CancelReviewToolOutput>;
  readonly createReview?: (
    input: CreateReviewToolInput,
    signal: AbortSignal,
  ) => Promise<CreateReviewToolOutput>;
  readonly getReview?: (
    input: GetReviewToolInput,
    signal: AbortSignal,
  ) => Promise<GetReviewToolOutput>;
  readonly listOpenReviews?: (
    input: ListOpenReviewsToolInput,
    signal: AbortSignal,
  ) => Promise<ListOpenReviewsToolOutput>;
}

function openReviewsText(output: ListOpenReviewsToolOutput) {
  if (output.reviews.length === 0) {
    return "No open AirUX reviews were found.";
  }
  return [
    "Open AirUX reviews:",
    ...output.reviews.map((review) =>
      [
        `${review.status}: ${review.title}`,
        `Review ID: ${review.id}`,
        `Client request ID: ${review.client_request_id}`,
        `Review URL: ${review.review_url}`,
        `Expires at: ${review.expires_at}`,
      ].join("\n"),
    ),
    "Use airux_get_review with a Review ID to resume waiting for its result.",
  ].join("\n\n");
}

function reviewResultText(output: GetReviewToolOutput) {
  const feedback = output.decision?.comment;
  const nextAction =
    output.status === "approved"
      ? "Continue the remaining authorized task."
      : output.status === "changes_requested"
        ? "Apply the feedback, verify the change, and submit a new Review if visual review is still required."
        : "Do not present this work as approved; create a replacement only if review is still required.";
  return [
    `AirUX review ${output.status.replace("_", " ")}:`,
    output.review_url,
    ...(feedback === null || feedback === undefined
      ? []
      : [`Feedback: ${feedback}`]),
    `Next: ${nextAction}`,
  ].join("\n");
}

function errorCause(error: unknown) {
  return error instanceof Error && "cause" in error ? error.cause : undefined;
}

function findCause<T>(
  error: unknown,
  predicate: (candidate: unknown) => candidate is T,
) {
  const visited = new Set<unknown>();
  let current = error;
  while (current !== undefined && !visited.has(current)) {
    if (predicate(current)) {
      return current;
    }
    visited.add(current);
    current = errorCause(current);
  }
  return undefined;
}

function findApiError(error: unknown) {
  return findCause(
    error,
    (candidate): candidate is AiruxApiError =>
      candidate instanceof AiruxApiError,
  );
}

function credentialManagerUrl(apiOrigin: string | undefined) {
  return apiOrigin === undefined
    ? "the AirUX credential manager"
    : `${apiOrigin}/#credential-manager`;
}

function apiCreationFailureText(
  error: AiruxApiError,
  apiOrigin: string | undefined,
) {
  if (
    error.code === "authentication_required" ||
    error.status === 401 ||
    error.status === 403
  ) {
    return [
      "Invalid AirUX agent credential.",
      `Confirm that the credential is active at ${credentialManagerUrl(apiOrigin)} and that the MCP server environment contains AIRUX_API_ORIGIN=<your AirUX origin> and AIRUX_AGENT_TOKEN=airux_agent_v1.<credential-id>.<secret>.`,
    ].join(" ");
  }
  if (error.code === "invalid_request" || error.status === 400) {
    return "AirUX rejected the review details. Check the title, claim, criteria, recording size, and client_request_id against the airux_create_review tool schema, then retry with corrected input.";
  }
  if (error.code === "conflict" || error.status === 409) {
    return "The client_request_id is already associated with different review details. Reuse an ID only when retrying identical input; after changing the review details, generate a new client_request_id.";
  }
  if (error.code === "rate_limited" || error.status === 429) {
    const delay =
      error.retryAfterMs === undefined
        ? "Wait briefly"
        : `Wait at least ${Math.max(1, Math.ceil(error.retryAfterMs / 1_000))} seconds`;
    return `AirUX rate-limited review creation. ${delay}, then retry with the same client_request_id so AirUX does not create a duplicate Review.`;
  }
  if (error.code === "not_found" || error.status === 404) {
    return `The configured AirUX origin does not expose review creation. Confirm that AIRUX_API_ORIGIN points to the deployed AirUX application${apiOrigin === undefined ? "" : ` (${apiOrigin})`}, then retry.`;
  }
  if (
    error.code === "internal_error" ||
    error.retryable ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return "The AirUX API is unavailable or did not finish the request. Check network access and AirUX service availability, then retry with the same client_request_id to avoid a duplicate Review.";
  }
  return "AirUX returned an invalid or untrusted creation response. Confirm AIRUX_API_ORIGIN points to the intended deployment and update the AirUX MCP package before retrying.";
}

function captureFailureOutput(error: unknown) {
  if (
    !(error instanceof CreateReviewWorkflowError) ||
    error.stage !== "capture"
  ) {
    return undefined;
  }

  let failure: CaptureFailure;
  if (error.message === "Invalid tool input") {
    failure = {
      code: "capture_failed",
      reason: "invalid_input",
      suggestion:
        "Correct client_request_id, title, claim, criteria, and capture_plan to match the current airux_create_review input schema, then retry.",
    };
  } else {
    const durationError = findCause(
      error,
      (candidate): candidate is CapturePlanDurationError =>
        candidate instanceof CapturePlanDurationError,
    );
    const executionError = findCause(
      error,
      (candidate): candidate is CapturePlanExecutionError =>
        candidate instanceof CapturePlanExecutionError,
    );

    if (durationError !== undefined) {
      failure = {
        action: durationError.operation,
        code: "capture_failed",
        reason: "duration_exceeded",
        ...(durationError.stepIndex === null
          ? {}
          : { step_index: durationError.stepIndex }),
        suggestion:
          "Shorten the capture plan or increase max_duration_ms within the tool limit, then retry.",
      };
    } else if (executionError !== undefined) {
      const suggestion =
        executionError.reason === "selector_not_found"
          ? "Confirm the page reaches the expected state and replace the selector with one that matches the intended element, then retry."
          : executionError.reason === "selector_not_unique"
            ? "Replace the selector with one that resolves to exactly one element, then retry."
            : executionError.reason === "step_timeout"
              ? "Confirm the expected page state is reached before this step, then correct its selector or timeout and retry."
              : executionError.reason === "navigation_failed"
                ? "Confirm the localhost server is running and the URL is reachable from the AirUX MCP process, then retry."
                : "Inspect the page state expected by this action, correct the capture step, and retry.";
      failure = {
        action: executionError.operation,
        code: "capture_failed",
        ...(executionError.matchCount === undefined
          ? {}
          : { match_count: executionError.matchCount }),
        reason: executionError.reason,
        ...(executionError.selector === undefined
          ? {}
          : { selector: executionError.selector }),
        ...(executionError.stepIndex === null
          ? {}
          : { step_index: executionError.stepIndex }),
        suggestion,
      };
    } else {
      failure = {
        code: "capture_failed",
        reason: "capture_unavailable",
        suggestion:
          "Confirm the localhost app and AirUX browser runtime are available, then retry with a smaller capture plan.",
      };
    }
  }

  return createReviewCaptureFailureOutputSchema.parse({ error: failure });
}

function captureFailureText(failure: CaptureFailure) {
  const location =
    failure.step_index === undefined
      ? failure.action === "start_url"
        ? " during initial navigation"
        : ""
      : ` at capture_plan.steps[${failure.step_index}] (${failure.action})`;
  const subject =
    failure.selector === undefined
      ? ""
      : ` Selector ${JSON.stringify(failure.selector)}`;
  const detail =
    failure.reason === "invalid_input"
      ? "AirUX rejected the review request before capture."
      : failure.reason === "selector_not_found"
        ? `AirUX capture failed${location}.${subject} matched no elements.`
        : failure.reason === "selector_not_unique"
          ? `AirUX capture failed${location}.${subject} matched ${failure.match_count ?? "multiple"} elements.`
          : failure.reason === "step_timeout"
            ? `AirUX capture timed out${location}.`
            : failure.reason === "navigation_failed"
              ? `AirUX could not reach the capture URL${location}.`
              : failure.reason === "duration_exceeded"
                ? `AirUX capture exceeded max_duration_ms${location}.`
                : failure.reason === "step_failed"
                  ? `AirUX capture failed${location}.`
                  : "AirUX could not start or complete the browser recording.";
  const cleanup =
    failure.reason === "invalid_input"
      ? "No recording was created."
      : "No Review was created. Temporary capture files were cleaned up where possible.";
  return `${detail} ${failure.suggestion} ${cleanup}`;
}

function createReviewFailure(error: unknown, apiOrigin: string | undefined) {
  const apiError = findApiError(error);
  if (apiError !== undefined) {
    return {
      text: `${apiCreationFailureText(apiError, apiOrigin)} The local recording was cleaned up where possible.`,
    };
  }

  const captureFailure = captureFailureOutput(error);
  if (captureFailure !== undefined) {
    return {
      structuredContent: captureFailure,
      text: captureFailureText(captureFailure.error),
    };
  }

  if (error instanceof CreateReviewWorkflowError) {
    if (error.stage === "create") {
      return {
        text: "AirUX recorded the evidence but could not create the remote Review. Confirm AIRUX_API_ORIGIN and AIRUX_AGENT_TOKEN are configured for the intended deployment, then retry with the same client_request_id to avoid a duplicate. The local recording was cleaned up where possible.",
      };
    }
    if (error.stage === "upload") {
      return {
        text: "AirUX recorded the evidence but could not upload it to private video storage. Check network access and retry with the same client_request_id so AirUX can recover the existing Review where possible. The local recording was cleaned up where possible.",
      };
    }
    if (error.stage === "processing") {
      return {
        text: "AirUX uploaded the evidence, but video processing failed, timed out, or returned an invalid status. Check airux_list_open_reviews before retrying; if the unresolved Review is still present, resume it with airux_get_review instead of creating a duplicate. The local recording was cleaned up where possible.",
      };
    }
    if (error.stage === "cleanup") {
      return {
        text: "AirUX created the Review, but could not confirm deletion of the local temporary recording. Check airux_list_open_reviews before retrying to avoid a duplicate Review, then remove any airux-browser-recording-* directory from the system temporary directory.",
      };
    }
  }

  return {
    text: "AirUX stopped because of an unexpected local review-creation error. Confirm the localhost app and MCP environment are available, then retry with the same client_request_id. The local recording was cleaned up where possible.",
  };
}

export function createAiruxMcpServer(options: AiruxMcpServerOptions) {
  const config = options.config;
  const cancelReview =
    options.cancelReview ??
    (config === undefined
      ? undefined
      : (input: CancelReviewToolInput, signal: AbortSignal) =>
          cancelAiruxReview(
            input,
            { api: new AiruxApiClient(config) },
            signal,
          ));
  const createReview =
    options.createReview ??
    (config === undefined
      ? undefined
      : (input: CreateReviewToolInput, signal: AbortSignal) =>
          createAiruxReview(
            input,
            { api: new AiruxApiClient(config) },
            signal,
          ));
  const getReview =
    options.getReview ??
    (config === undefined
      ? undefined
      : (input: GetReviewToolInput, signal: AbortSignal) =>
          getAiruxReview(input, { api: new AiruxApiClient(config) }, signal));
  const listOpenReviews =
    options.listOpenReviews ??
    (config === undefined
      ? undefined
      : (input: ListOpenReviewsToolInput, signal: AbortSignal) =>
          listAiruxOpenReviews(
            input,
            { api: new AiruxApiClient(config) },
            signal,
          ));
  if (
    cancelReview === undefined ||
    createReview === undefined ||
    getReview === undefined ||
    listOpenReviews === undefined
  ) {
    throw new Error("AirUX MCP server configuration is required");
  }

  const server = new McpServer(
    { name: "airux", version: "0.1.0" },
    { instructions: AIRUX_MCP_INSTRUCTIONS },
  );
  server.registerTool(
    "airux_cancel_review",
    {
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Cancel a draft or pending AirUX Review and schedule its Evidence for deletion.",
      inputSchema: cancelReviewToolInputSchema,
      outputSchema: cancelReviewToolOutputSchema,
      title: "Cancel AirUX Review",
    },
    async (input, context) => {
      try {
        const output = await cancelReview(input, context.mcpReq.signal);
        return {
          content: [
            {
              type: "text",
              text: `AirUX review cancelled:\n${output.review_url}`,
            },
          ],
          structuredContent: output,
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "AirUX could not cancel the Review.",
            },
          ],
          isError: true,
        };
      }
    },
  );
  server.registerTool(
    "airux_create_review",
    {
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Record a video or screen recording of a localhost or loopback web page when the user requests video evidence, visual proof, or human review. Prefer this over general browser control for reviewable recordings. After this returns pending, immediately call airux_get_review with the returned review_id.",
      inputSchema: createReviewToolInputSchema,
      outputSchema: createReviewToolOutputSchema,
      title: "Create AirUX Review",
    },
    async (input, context) => {
      try {
        const output = await createReview(input, context.mcpReq.signal);
        return {
          content: [
            {
              type: "text",
              text: [
                "Human review required:",
                output.review_url,
                `Review ID: ${output.review_id}`,
                "Next: immediately call airux_get_review with this Review ID and wait for the human decision before finishing the active task.",
              ].join("\n"),
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        const failure = createReviewFailure(error, config?.apiOrigin);
        return {
          content: [
            {
              type: "text",
              text: failure.text,
            },
          ],
          ...(failure.structuredContent === undefined
            ? {}
            : { structuredContent: failure.structuredContent }),
          isError: true,
        };
      }
    },
  );
  server.registerTool(
    "airux_get_review",
    {
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Wait locally for an AirUX human review to resolve, then return the terminal status and Decision so the active agent task can continue.",
      inputSchema: getReviewToolInputSchema,
      outputSchema: getReviewToolOutputSchema,
      title: "Get AirUX Review Result",
    },
    async (input, context) => {
      try {
        const output = await getReview(input, context.mcpReq.signal);
        return {
          content: [
            {
              type: "text",
              text: reviewResultText(output),
            },
          ],
          structuredContent: output,
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "AirUX could not retrieve the human review result.",
            },
          ],
          isError: true,
        };
      }
    },
  );
  server.registerTool(
    "airux_list_open_reviews",
    {
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "List unresolved AirUX reviews created by the current agent credential so interrupted work can resume.",
      inputSchema: listOpenReviewsToolInputSchema,
      outputSchema: listOpenReviewsToolOutputSchema,
      title: "List Open AirUX Reviews",
    },
    async (input, context) => {
      try {
        const output = await listOpenReviews(input, context.mcpReq.signal);
        return {
          content: [{ type: "text", text: openReviewsText(output) }],
          structuredContent: output,
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "AirUX could not retrieve the open Reviews.",
            },
          ],
          isError: true,
        };
      }
    },
  );
  return server;
}
