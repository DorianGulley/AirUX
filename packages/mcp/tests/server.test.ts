import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiruxApiError } from "../src/api-client.js";
import { CreateReviewWorkflowError } from "../src/create-review.js";
import { AIRUX_MCP_INSTRUCTIONS, createAiruxMcpServer } from "../src/server.js";

const REVIEW_ID = "20000000-0000-4000-8000-000000000045";
const toolInput = {
  capture_plan: {
    max_duration_ms: 30_000,
    start_url: "http://localhost:3000",
    steps: [{ action: "pause", duration_ms: 250 }],
    viewport: { height: 720, width: 1_280 },
  },
  claim: "The flow works.",
  client_request_id: "agent-run-45",
  criteria: [{ id: "works", prompt: "The flow completes." }],
  title: "Review the flow",
};

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

async function connect(
  createReview: NonNullable<
    Parameters<typeof createAiruxMcpServer>[0]["createReview"]
  >,
  getReview: NonNullable<
    Parameters<typeof createAiruxMcpServer>[0]["getReview"]
  > = vi.fn(async () => ({
    review_id: REVIEW_ID,
    review_url: `https://airux.example/reviews/${REVIEW_ID}`,
    status: "approved" as const,
    decision: {
      outcome: "approved" as const,
      comment: null,
      created_at: "2026-08-20T22:10:00.000Z",
    },
  })),
  listOpenReviews: NonNullable<
    Parameters<typeof createAiruxMcpServer>[0]["listOpenReviews"]
  > = vi.fn(async () => ({ reviews: [] })),
  cancelReview: NonNullable<
    Parameters<typeof createAiruxMcpServer>[0]["cancelReview"]
  > = vi.fn(async () => ({
    review_id: REVIEW_ID,
    review_url: `https://airux.example/reviews/${REVIEW_ID}`,
    status: "cancelled" as const,
  })),
  apiOrigin?: string,
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createAiruxMcpServer({
    cancelReview,
    ...(apiOrigin === undefined
      ? {}
      : { config: { agentToken: "unused-test-token", apiOrigin } }),
    createReview,
    getReview,
    listOpenReviews,
  });
  const client = new Client({ name: "airux-test", version: "0.1.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  closers.push(
    () => client.close(),
    () => server.close(),
  );
  return client;
}

describe("AirUX MCP server", () => {
  it("advertises the cross-tool review workflow during MCP initialization", async () => {
    const client = await connect(
      vi.fn(async () => ({
        review_id: REVIEW_ID,
        review_url: `https://airux.example/reviews/${REVIEW_ID}`,
        status: "pending" as const,
      })),
    );

    expect(client.getInstructions()).toBe(AIRUX_MCP_INSTRUCTIONS);
    expect(client.getInstructions()).toContain(
      "immediately call airux_get_review",
    );
    expect(client.getInstructions()).toContain("video evidence");
  });

  it("advertises and invokes airux_create_review over MCP", async () => {
    const createReview = vi.fn(async () => ({
      review_id: REVIEW_ID,
      review_url: `https://airux.example/reviews/${REVIEW_ID}`,
      status: "pending" as const,
    }));
    const client = await connect(createReview);

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      "airux_cancel_review",
      "airux_create_review",
      "airux_get_review",
      "airux_list_open_reviews",
    ]);
    const result = await client.callTool({
      arguments: toolInput,
      name: "airux_create_review",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      review_id: REVIEW_ID,
      review_url: `https://airux.example/reviews/${REVIEW_ID}`,
      status: "pending",
    });
    expect(result.content).toEqual([
      {
        text: [
          "Human review required:",
          `https://airux.example/reviews/${REVIEW_ID}`,
          `Review ID: ${REVIEW_ID}`,
          "Next: immediately call airux_get_review with this Review ID and wait for the human decision before finishing the active task.",
        ].join("\n"),
        type: "text",
      },
    ]);
    expect(createReview).toHaveBeenCalledWith(
      toolInput,
      expect.any(AbortSignal),
    );
  });

  it("cancels an open Review and returns the terminal handoff", async () => {
    const cancelReview = vi.fn(async () => ({
      review_id: REVIEW_ID,
      review_url: `https://airux.example/reviews/${REVIEW_ID}`,
      status: "cancelled" as const,
    }));
    const client = await connect(
      vi.fn(async () => ({
        review_id: REVIEW_ID,
        review_url: `https://airux.example/reviews/${REVIEW_ID}`,
        status: "pending" as const,
      })),
      undefined,
      undefined,
      cancelReview,
    );

    const result = await client.callTool({
      arguments: { review_id: REVIEW_ID },
      name: "airux_cancel_review",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      review_id: REVIEW_ID,
      review_url: `https://airux.example/reviews/${REVIEW_ID}`,
      status: "cancelled",
    });
    expect(result.content).toEqual([
      {
        text: `AirUX review cancelled:\nhttps://airux.example/reviews/${REVIEW_ID}`,
        type: "text",
      },
    ]);
    expect(cancelReview).toHaveBeenCalledWith(
      { review_id: REVIEW_ID },
      expect.any(AbortSignal),
    );
  });

  it("lists resumable Reviews and explains how to continue waiting", async () => {
    const listOpenReviews = vi.fn(async () => ({
      reviews: [
        {
          id: REVIEW_ID,
          review_url: `https://airux.example/reviews/${REVIEW_ID}`,
          client_request_id: "agent-run-45",
          title: "Review the flow",
          status: "pending" as const,
          version: 1,
          created_at: "2026-08-20T22:00:00.000Z",
          expires_at: "2026-08-23T22:00:00.000Z",
        },
      ],
    }));
    const client = await connect(
      vi.fn(async () => ({
        review_id: REVIEW_ID,
        review_url: `https://airux.example/reviews/${REVIEW_ID}`,
        status: "pending" as const,
      })),
      undefined,
      listOpenReviews,
    );

    const result = await client.callTool({
      arguments: {},
      name: "airux_list_open_reviews",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      reviews: [
        {
          id: REVIEW_ID,
          client_request_id: "agent-run-45",
          status: "pending",
        },
      ],
    });
    expect(JSON.stringify(result.content)).toContain(REVIEW_ID);
    expect(JSON.stringify(result.content)).toContain("airux_get_review");
    expect(listOpenReviews).toHaveBeenCalledWith({}, expect.any(AbortSignal));
  });

  it("returns a clear empty recovery result", async () => {
    const client = await connect(
      vi.fn(async () => ({
        review_id: REVIEW_ID,
        review_url: `https://airux.example/reviews/${REVIEW_ID}`,
        status: "pending" as const,
      })),
    );

    const result = await client.callTool({
      arguments: {},
      name: "airux_list_open_reviews",
    });

    expect(result.content).toEqual([
      { type: "text", text: "No open AirUX reviews were found." },
    ]);
    expect(result.structuredContent).toEqual({ reviews: [] });
  });

  it("waits for and returns the final AirUX review result", async () => {
    const getReview = vi.fn(async () => ({
      review_id: REVIEW_ID,
      review_url: `https://airux.example/reviews/${REVIEW_ID}`,
      status: "changes_requested" as const,
      decision: {
        outcome: "changes_requested" as const,
        comment: "The menu overlaps the heading.",
        created_at: "2026-08-20T22:10:00.000Z",
      },
    }));
    const client = await connect(
      vi.fn(async () => ({
        review_id: REVIEW_ID,
        review_url: `https://airux.example/reviews/${REVIEW_ID}`,
        status: "pending" as const,
      })),
      getReview,
    );

    const result = await client.callTool({
      arguments: { review_id: REVIEW_ID },
      name: "airux_get_review",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      review_id: REVIEW_ID,
      status: "changes_requested",
      decision: { comment: "The menu overlaps the heading." },
    });
    expect(result.content).toEqual([
      {
        text: [
          "AirUX review changes requested:",
          `https://airux.example/reviews/${REVIEW_ID}`,
          "Feedback: The menu overlaps the heading.",
          "Next: Apply the feedback, verify the change, and submit a new Review if visual review is still required.",
        ].join("\n"),
        type: "text",
      },
    ]);
    expect(getReview).toHaveBeenCalledWith(
      { review_id: REVIEW_ID },
      expect.any(AbortSignal),
    );
  });

  it("returns a sanitized tool-level error", async () => {
    const client = await connect(async () => {
      throw new Error("secret-token-and-provider-url");
    });

    const result = await client.callTool({
      arguments: toolInput,
      name: "airux_create_review",
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(
      "secret-token-and-provider-url",
    );
    expect(JSON.stringify(result)).toContain(
      "unexpected local review-creation error",
    );
  });

  it("explains how to fix an invalid agent credential without exposing it", async () => {
    const client = await connect(
      async () => {
        throw new CreateReviewWorkflowError(
          "create",
          "secret workflow failure",
          {
            cause: new AiruxApiError("secret API response", {
              code: "authentication_required",
              retryable: false,
              status: 401,
            }),
          },
        );
      },
      undefined,
      undefined,
      undefined,
      "https://airux.example",
    );

    const result = await client.callTool({
      arguments: toolInput,
      name: "airux_create_review",
    });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(serialized).toContain("Invalid AirUX agent credential");
    expect(serialized).toContain("https://airux.example/#credential-manager");
    expect(serialized).toContain(
      "AIRUX_AGENT_TOKEN=airux_agent_v1.<credential-id>.<secret>",
    );
    expect(serialized).not.toContain("secret workflow failure");
    expect(serialized).not.toContain("secret API response");
  });

  it.each([
    {
      error: new AiruxApiError("private rejection", {
        code: "invalid_request",
        retryable: false,
        status: 400,
      }),
      expected: "Check the title, claim, criteria, recording size",
    },
    {
      error: new AiruxApiError("private conflict", {
        code: "conflict",
        retryable: false,
        status: 409,
      }),
      expected: "Reuse an ID only when retrying identical input",
    },
    {
      error: new AiruxApiError("private rate limit", {
        code: "rate_limited",
        retryAfterMs: 4_200,
        retryable: true,
        status: 429,
      }),
      expected: "Wait at least 5 seconds",
    },
    {
      error: new AiruxApiError("private outage", {
        code: "internal_error",
        retryable: true,
        status: 503,
      }),
      expected: "Check network access and AirUX service availability",
    },
    {
      error: new AiruxApiError("private wrong endpoint", {
        code: "not_found",
        retryable: false,
        status: 404,
      }),
      expected: "does not expose review creation",
    },
  ])(
    "returns actionable API failure guidance: $expected",
    async ({ error, expected }) => {
      const client = await connect(async () => {
        throw new CreateReviewWorkflowError("create", "private wrapper", {
          cause: error,
        });
      });

      const result = await client.callTool({
        arguments: toolInput,
        name: "airux_create_review",
      });
      const serialized = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(serialized).toContain(expected);
      expect(serialized).not.toContain(error.message);
      expect(serialized).not.toContain("private wrapper");
    },
  );

  it.each([
    {
      stage: "capture" as const,
      message: "Invalid tool input",
      expected: "rejected the review request before capture",
    },
    {
      stage: "capture" as const,
      message: "private workflow failure",
      expected: "Confirm the localhost app is running",
    },
    {
      stage: "create" as const,
      message: "private workflow failure",
      expected: "Confirm AIRUX_API_ORIGIN and AIRUX_AGENT_TOKEN",
    },
    {
      stage: "upload" as const,
      message: "private workflow failure",
      expected: "could not upload it to private video storage",
    },
    {
      stage: "processing" as const,
      message: "private workflow failure",
      expected: "resume it with airux_get_review",
    },
    {
      stage: "cleanup" as const,
      message: "private workflow failure",
      expected: "airux-browser-recording-*",
    },
  ])(
    "returns actionable $stage failure guidance",
    async ({ stage, message, expected }) => {
      const client = await connect(async () => {
        throw new CreateReviewWorkflowError(stage, message);
      });

      const result = await client.callTool({
        arguments: toolInput,
        name: "airux_create_review",
      });
      const serialized = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(serialized).toContain(expected);
      if (message === "private workflow failure") {
        expect(serialized).not.toContain(message);
      }
    },
  );
});
