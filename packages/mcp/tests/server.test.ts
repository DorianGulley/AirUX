import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiruxMcpServer } from "../src/server.js";

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
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createAiruxMcpServer({ createReview, getReview });
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
  it("advertises and invokes airux_create_review over MCP", async () => {
    const createReview = vi.fn(async () => ({
      review_id: REVIEW_ID,
      review_url: `https://airux.example/reviews/${REVIEW_ID}`,
      status: "pending" as const,
    }));
    const client = await connect(createReview);

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      "airux_create_review",
      "airux_get_review",
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
        text: `Human review required:\nhttps://airux.example/reviews/${REVIEW_ID}`,
        type: "text",
      },
    ]);
    expect(createReview).toHaveBeenCalledWith(
      toolInput,
      expect.any(AbortSignal),
    );
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
        text: `AirUX review changes requested:\nhttps://airux.example/reviews/${REVIEW_ID}\nFeedback: The menu overlaps the heading.`,
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
  });
});
