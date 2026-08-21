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
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createAiruxMcpServer({ createReview });
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
