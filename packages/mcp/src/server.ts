import {
  type CreateReviewToolInput,
  type CreateReviewToolOutput,
  createReviewToolInputSchema,
  createReviewToolOutputSchema,
  type GetReviewToolInput,
  type GetReviewToolOutput,
  getReviewToolInputSchema,
  getReviewToolOutputSchema,
} from "@airux/shared/v1";
import { McpServer } from "@modelcontextprotocol/server";

import { AiruxApiClient } from "./api-client.js";
import type { AiruxRuntimeConfig } from "./config.js";
import { createAiruxReview } from "./create-review.js";
import { getAiruxReview } from "./get-review.js";

export interface AiruxMcpServerOptions {
  readonly config?: AiruxRuntimeConfig;
  readonly createReview?: (
    input: CreateReviewToolInput,
    signal: AbortSignal,
  ) => Promise<CreateReviewToolOutput>;
  readonly getReview?: (
    input: GetReviewToolInput,
    signal: AbortSignal,
  ) => Promise<GetReviewToolOutput>;
}

export function createAiruxMcpServer(options: AiruxMcpServerOptions) {
  const config = options.config;
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
  if (createReview === undefined || getReview === undefined) {
    throw new Error("AirUX MCP server configuration is required");
  }

  const server = new McpServer({ name: "airux", version: "0.1.0" });
  server.registerTool(
    "airux_create_review",
    {
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Record a constrained localhost browser flow and submit it to AirUX for human review.",
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
              text: `Human review required:\n${output.review_url}`,
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
        "Wait for an AirUX human review to resolve and return its decision.",
      inputSchema: getReviewToolInputSchema,
      outputSchema: getReviewToolOutputSchema,
      title: "Get AirUX Review Result",
    },
    async (input, context) => {
      try {
        const output = await getReview(input, context.mcpReq.signal);
        const feedback = output.decision?.comment;
        return {
          content: [
            {
              type: "text",
              text: [
                `AirUX review ${output.status.replace("_", " ")}:`,
                output.review_url,
                ...(feedback === null || feedback === undefined
                  ? []
                  : [`Feedback: ${feedback}`]),
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
              text: "AirUX could not retrieve the human review result.",
            },
          ],
          isError: true,
        };
      }
    },
  );
  return server;
}
