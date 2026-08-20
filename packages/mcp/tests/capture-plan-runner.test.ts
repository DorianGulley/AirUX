import type { Locator, Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CapturePlanDurationError,
  CapturePlanExecutionError,
  runCapturePlan,
} from "../src/capture-plan-runner.js";

interface LocatorDouble {
  click: ReturnType<typeof vi.fn>;
  dragTo: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  hover: ReturnType<typeof vi.fn>;
  press: ReturnType<typeof vi.fn>;
  waitFor: ReturnType<typeof vi.fn>;
}

function createPageDouble() {
  const locators = new Map<string, LocatorDouble>();
  const locator = vi.fn((selector: string) => {
    let current = locators.get(selector);
    if (current === undefined) {
      current = {
        click: vi.fn().mockResolvedValue(undefined),
        dragTo: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        hover: vi.fn().mockResolvedValue(undefined),
        press: vi.fn().mockResolvedValue(undefined),
        waitFor: vi.fn().mockResolvedValue(undefined),
      };
      locators.set(selector, current);
    }
    return current as unknown as Locator;
  });
  const page = {
    goto: vi.fn().mockResolvedValue(null),
    locator,
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Page;

  return {
    page,
    goto: page.goto as ReturnType<typeof vi.fn>,
    locator,
    locators,
    wheel: page.mouse.wheel as ReturnType<typeof vi.fn>,
  };
}

const basePlan = {
  start_url: "http://127.0.0.1:3000/reviews",
  viewport: { width: 1_280, height: 720 },
  max_duration_ms: 30_000,
  steps: [{ action: "click", selector: "#open-review" }],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("runCapturePlan", () => {
  it("validates before navigating", async () => {
    const { page, goto } = createPageDouble();

    await expect(
      runCapturePlan(page, { ...basePlan, start_url: "https://example.com" }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(goto).not.toHaveBeenCalled();
  });

  it("navigates to the start URL and executes every supported action", async () => {
    vi.useFakeTimers();
    const { page, goto, locators, wheel } = createPageDouble();
    const execution = runCapturePlan(page, {
      ...basePlan,
      steps: [
        {
          action: "goto",
          url: "http://localhost:3000/account",
          timeout_ms: 2_000,
        },
        { action: "click", selector: "#submit", timeout_ms: 1_000 },
        { action: "fill", selector: "#email", value: "person@example.com" },
        { action: "press", selector: "#search", key: "Enter" },
        { action: "hover", selector: "#menu" },
        {
          action: "drag",
          source_selector: "#card",
          target_selector: "#column",
        },
        { action: "scroll", delta_x: 0, delta_y: 600 },
        {
          action: "scroll",
          selector: "#panel",
          delta_x: 25,
          delta_y: -50,
        },
        { action: "wait_for", selector: "#ready" },
        { action: "pause", duration_ms: 500 },
      ],
    });

    await vi.advanceTimersByTimeAsync(500);
    await execution;

    expect(goto).toHaveBeenNthCalledWith(
      1,
      basePlan.start_url,
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(goto).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3000/account",
      expect.objectContaining({ timeout: 2_000 }),
    );
    expect(locators.get("#submit")?.click).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 1_000 }),
    );
    expect(locators.get("#email")?.fill).toHaveBeenCalledWith(
      "person@example.com",
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(locators.get("#search")?.press).toHaveBeenCalledWith(
      "Enter",
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(locators.get("#menu")?.hover).toHaveBeenCalledOnce();
    expect(locators.get("#card")?.dragTo).toHaveBeenCalledWith(
      locators.get("#column"),
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(wheel).toHaveBeenNthCalledWith(1, 0, 600);
    expect(locators.get("#panel")?.hover).toHaveBeenCalledOnce();
    expect(wheel).toHaveBeenNthCalledWith(2, 25, -50);
    expect(locators.get("#ready")?.waitFor).toHaveBeenCalledWith(
      expect.objectContaining({ state: "visible", timeout: 30_000 }),
    );
  });

  it("reports the failing step without exposing a new action surface", async () => {
    const { page, locator } = createPageDouble();
    const failure = new Error("selector did not resolve");
    const button = locator("#open-review") as unknown as LocatorDouble;
    button.click.mockRejectedValueOnce(failure);
    const execution = runCapturePlan(page, basePlan);

    const error = await execution.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CapturePlanExecutionError);
    expect(error).toMatchObject({
      cause: failure,
      operation: "click",
      stepIndex: 0,
    });
  });

  it("reports an initial navigation failure separately", async () => {
    const { page, goto } = createPageDouble();
    const failure = new Error("server unavailable");
    goto.mockRejectedValueOnce(failure);

    await expect(runCapturePlan(page, basePlan)).rejects.toMatchObject({
      cause: failure,
      operation: "start_url",
      stepIndex: null,
    });
  });

  it("aborts execution at the plan duration limit", async () => {
    vi.useFakeTimers();
    const { page } = createPageDouble();
    const execution = runCapturePlan(page, {
      ...basePlan,
      max_duration_ms: 50,
      steps: [{ action: "pause", duration_ms: 100 }],
    });
    const result = execution.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(50);

    expect(await result).toBeInstanceOf(CapturePlanDurationError);
  });
});
