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

import { AiruxApiClient } from "./api-client.js";
import { cancelAiruxReview } from "./cancel-review.js";
import type { AiruxRuntimeConfig } from "./config.js";
import { createAiruxReview } from "./create-review.js";
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
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "AirUX could not create the human review. The local recording was cleaned up where possible.",
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
