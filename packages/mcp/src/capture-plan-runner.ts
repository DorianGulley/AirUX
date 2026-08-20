import {
  type CapturePlan,
  type CaptureStep,
  CONTRACT_LIMITS,
  capturePlanSchema,
} from "@airux/shared/v1";
import type { Page } from "playwright";

const DEFAULT_ACTION_TIMEOUT_MS = CONTRACT_LIMITS.timeoutMs;

export type CapturePlanOperation = CaptureStep["action"] | "start_url";

export class CapturePlanDurationError extends Error {
  constructor(maxDurationMs: number) {
    super(`Capture plan exceeded its ${maxDurationMs} ms duration limit`);
    this.name = "CapturePlanDurationError";
  }
}

export class CapturePlanExecutionError extends Error {
  readonly operation: CapturePlanOperation;
  readonly stepIndex: number | null;

  constructor(
    operation: CapturePlanOperation,
    stepIndex: number | null,
    cause: unknown,
  ) {
    const location =
      stepIndex === null ? "initial navigation" : `step ${stepIndex + 1}`;
    super(`Capture plan ${location} (${operation}) failed`, { cause });
    this.name = "CapturePlanExecutionError";
    this.operation = operation;
    this.stepIndex = stepIndex;
  }
}

function timeoutFor(step: CaptureStep) {
  return "timeout_ms" in step && step.timeout_ms !== undefined
    ? step.timeout_ms
    : DEFAULT_ACTION_TIMEOUT_MS;
}

function pause(durationMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function executeStep(page: Page, step: CaptureStep, signal: AbortSignal) {
  const timeout = timeoutFor(step);

  switch (step.action) {
    case "goto":
      await page.goto(step.url, { signal, timeout });
      return;
    case "click":
      await page.locator(step.selector).click({ signal, timeout });
      return;
    case "fill":
      await page.locator(step.selector).fill(step.value, { signal, timeout });
      return;
    case "press":
      await page.locator(step.selector).press(step.key, { signal, timeout });
      return;
    case "hover":
      await page.locator(step.selector).hover({ signal, timeout });
      return;
    case "drag":
      await page
        .locator(step.source_selector)
        .dragTo(page.locator(step.target_selector), { signal, timeout });
      return;
    case "scroll":
      if (step.selector !== undefined) {
        await page.locator(step.selector).hover({
          signal,
          timeout: DEFAULT_ACTION_TIMEOUT_MS,
        });
      }
      if (signal.aborted) {
        throw signal.reason;
      }
      await page.mouse.wheel(step.delta_x, step.delta_y);
      return;
    case "wait_for":
      await page.locator(step.selector).waitFor({
        signal,
        state: step.state,
        timeout,
      });
      return;
    case "pause":
      await pause(step.duration_ms, signal);
      return;
  }
}

export async function runCapturePlan(page: Page, input: unknown) {
  const plan: CapturePlan = capturePlanSchema.parse(input);
  const durationController = new AbortController();
  const durationError = new CapturePlanDurationError(plan.max_duration_ms);
  const durationTimer = setTimeout(
    () => durationController.abort(durationError),
    plan.max_duration_ms,
  );

  try {
    try {
      await page.goto(plan.start_url, {
        signal: durationController.signal,
        timeout: DEFAULT_ACTION_TIMEOUT_MS,
      });
    } catch (error) {
      if (durationController.signal.aborted) {
        throw durationError;
      }
      throw new CapturePlanExecutionError("start_url", null, error);
    }

    for (const [stepIndex, step] of plan.steps.entries()) {
      try {
        await executeStep(page, step, durationController.signal);
      } catch (error) {
        if (durationController.signal.aborted) {
          throw durationError;
        }
        throw new CapturePlanExecutionError(step.action, stepIndex, error);
      }
    }
  } finally {
    clearTimeout(durationTimer);
  }
}
