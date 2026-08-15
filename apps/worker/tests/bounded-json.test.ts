import { describe, expect, it } from "vitest";

import {
  InvalidJsonBodyError,
  ResponseBodyError,
  readJsonRequest,
  readJsonResponse,
} from "../src/bounded-json.js";

describe("bounded JSON", () => {
  it("parses a valid JSON request within the limit", async () => {
    const request = new Request("https://airux.example", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: "Codex" }),
    });

    await expect(readJsonRequest(request, 64)).resolves.toEqual({
      name: "Codex",
    });
  });

  it.each([
    [
      "unsupported media type",
      new Request("https://airux.example", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      64,
    ],
    [
      "declared oversized body",
      new Request("https://airux.example", {
        method: "POST",
        headers: {
          "content-length": "65",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      64,
    ],
    [
      "streamed oversized body",
      new Request("https://airux.example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(80) }),
      }),
      64,
    ],
    [
      "malformed JSON",
      new Request("https://airux.example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      64,
    ],
  ])("rejects an %s request", async (_name, request, limit) => {
    await expect(readJsonRequest(request, limit)).rejects.toBeInstanceOf(
      InvalidJsonBodyError,
    );
  });

  it("rejects an oversized provider response", async () => {
    const response = Response.json({ value: "x".repeat(80) });

    await expect(readJsonResponse(response, 64)).rejects.toBeInstanceOf(
      ResponseBodyError,
    );
  });
});
