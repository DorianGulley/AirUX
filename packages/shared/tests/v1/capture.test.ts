import { describe, expect, it } from "vitest";
import { capturePlanSchema, captureStepSchema } from "../../src/v1/capture.js";
import { CONTRACT_LIMITS } from "../../src/v1/limits.js";

describe("captureStepSchema", () => {
  it.each([
    { action: "goto", url: "http://localhost:3000/account" },
    { action: "click", selector: "button[type=submit]" },
    { action: "fill", selector: "#email", value: "person@example.com" },
    { action: "press", selector: "#search", key: "Enter" },
    { action: "hover", selector: "[data-menu]" },
    {
      action: "drag",
      source_selector: "#card",
      target_selector: "#column",
    },
    { action: "scroll", delta_x: 0, delta_y: 600 },
    { action: "wait_for", selector: "[data-ready]", state: "visible" },
    { action: "pause", duration_ms: 500 },
  ])("accepts the $action action", (step) => {
    expect(captureStepSchema.safeParse(step).success).toBe(true);
  });

  it("rejects unsupported actions", () => {
    expect(
      captureStepSchema.safeParse({ action: "evaluate", script: "alert(1)" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      captureStepSchema.safeParse({
        action: "click",
        selector: "button",
        force: true,
      }).success,
    ).toBe(false);
  });

  it("requires scroll movement", () => {
    expect(
      captureStepSchema.safeParse({
        action: "scroll",
        delta_x: 0,
        delta_y: 0,
      }).success,
    ).toBe(false);
  });
});

describe("capturePlanSchema", () => {
  const validPlan = {
    start_url: "http://127.0.0.1:3000/reviews",
    viewport: { width: 1_280, height: 720 },
    max_duration_ms: 30_000,
    steps: [{ action: "click", selector: "#open-review" }],
  };

  it("accepts a bounded localhost capture plan", () => {
    expect(capturePlanSchema.parse(validPlan)).toEqual(validPlan);
  });

  it.each([
    "https://example.com/reviews",
    "file:///tmp/index.html",
    "http://localhost.example.com/reviews",
  ])("rejects a non-local start URL: %s", (startUrl) => {
    expect(
      capturePlanSchema.safeParse({ ...validPlan, start_url: startUrl })
        .success,
    ).toBe(false);
  });

  it("accepts the IPv6 loopback address", () => {
    expect(
      capturePlanSchema.safeParse({
        ...validPlan,
        start_url: "http://[::1]:3000/reviews",
      }).success,
    ).toBe(true);
  });

  it("rejects plans over the duration limit", () => {
    expect(
      capturePlanSchema.safeParse({
        ...validPlan,
        max_duration_ms: CONTRACT_LIMITS.captureDurationMs + 1,
      }).success,
    ).toBe(false);
  });

  it("rejects viewports outside the supported range", () => {
    expect(
      capturePlanSchema.safeParse({
        ...validPlan,
        viewport: { width: CONTRACT_LIMITS.viewportWidth.min - 1, height: 720 },
      }).success,
    ).toBe(false);
  });

  it("rejects an empty demonstration", () => {
    expect(
      capturePlanSchema.safeParse({ ...validPlan, steps: [] }).success,
    ).toBe(false);
  });
});
