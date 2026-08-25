import {
  type CancelReviewToolInput,
  type CancelReviewToolOutput,
  type CreateReviewToolInput,
  type CreateReviewToolOutput,
  cancelReviewToolInputSchema,
  cancelReviewToolOutputSchema,
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
import type { AiruxRuntimeConfig } from "./config.js";
import {
  CreateReviewWorkflowError,
  createAiruxReview,
} from "./create-review.js";
import { getAiruxReview } from "./get-review.js";
import { listAiruxOpenReviews } from "./list-open-reviews.js";

export const AIRUX_MCP_INSTRUCTIONS = [
  "Use AirUX when the user requests video evidence, visual proof, a recorded localhost demonstration, remote approval, or asynchronous human review of web work.",
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

function findApiError(error: unknown) {
  const visited = new Set<unknown>();
  let current = error;
  while (current !== undefined && !visited.has(current)) {
    if (current instanceof AiruxApiError) {
      return current;
    }
    visited.add(current);
    current = errorCause(current);
  }
  return undefined;
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

function createReviewFailureText(
  error: unknown,
  apiOrigin: string | undefined,
) {
  const apiError = findApiError(error);
  if (apiError !== undefined) {
    return `${apiCreationFailureText(apiError, apiOrigin)} The local recording was cleaned up where possible.`;
  }

  if (error instanceof CreateReviewWorkflowError) {
    if (error.stage === "capture") {
      if (error.message === "Invalid tool input") {
        return "AirUX rejected the review request before capture. Check client_request_id, title, claim, criteria, and capture_plan against the current airux_create_review tool schema, then retry with corrected input. No recording was uploaded.";
      }
      return "AirUX could not record the browser evidence. Confirm the localhost app is running, the capture_plan start URL is loopback-only, and each selector matches a visible interactive element within max_duration_ms, then retry. Temporary capture files were cleaned up where possible.";
    }
    if (error.stage === "create") {
      return "AirUX recorded the evidence but could not create the remote Review. Confirm AIRUX_API_ORIGIN and AIRUX_AGENT_TOKEN are configured for the intended deployment, then retry with the same client_request_id to avoid a duplicate. The local recording was cleaned up where possible.";
    }
    if (error.stage === "upload") {
      return "AirUX recorded the evidence but could not upload it to private video storage. Check network access and retry with the same client_request_id so AirUX can recover the existing Review where possible. The local recording was cleaned up where possible.";
    }
    if (error.stage === "processing") {
      return "AirUX uploaded the evidence, but video processing failed, timed out, or returned an invalid status. Check airux_list_open_reviews before retrying; if the unresolved Review is still present, resume it with airux_get_review instead of creating a duplicate. The local recording was cleaned up where possible.";
    }
    if (error.stage === "cleanup") {
      return "AirUX created the Review, but could not confirm deletion of the local temporary recording. Check airux_list_open_reviews before retrying to avoid a duplicate Review, then remove any airux-browser-recording-* directory from the system temporary directory.";
    }
  }

  return "AirUX stopped because of an unexpected local review-creation error. Confirm the localhost app and MCP environment are available, then retry with the same client_request_id. The local recording was cleaned up where possible.";
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
        "Turn a request for video evidence or visual proof into a constrained localhost recording and submit it for human review. After this returns pending, immediately call airux_get_review with the returned review_id.",
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
        return {
          content: [
            {
              type: "text",
              text: createReviewFailureText(error, config?.apiOrigin),
            },
          ],
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
