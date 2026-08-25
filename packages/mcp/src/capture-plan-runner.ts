import {
  type CaptureFailureAction,
  type CaptureFailureReason,
  type CapturePlan,
  type CaptureStep,
  CONTRACT_LIMITS,
  capturePlanSchema,
} from "@airux/shared/v1";
import type { Page } from "playwright";

const DEFAULT_ACTION_TIMEOUT_MS = CONTRACT_LIMITS.timeoutMs;

export type CapturePlanOperation = CaptureFailureAction;

type StepFailureReason = Extract<
  CaptureFailureReason,
  | "navigation_failed"
  | "selector_not_found"
  | "selector_not_unique"
  | "step_timeout"
  | "step_failed"
>;

export class CapturePlanDurationError extends Error {
  readonly operation: CapturePlanOperation;
  readonly stepIndex: number | null;

  constructor(
    maxDurationMs: number,
    operation: CapturePlanOperation,
    stepIndex: number | null,
  ) {
    super(`Capture plan exceeded its ${maxDurationMs} ms duration limit`);
    this.name = "CapturePlanDurationError";
    this.operation = operation;
    this.stepIndex = stepIndex;
  }
}

export class CapturePlanExecutionError extends Error {
  readonly operation: CapturePlanOperation;
  readonly reason: StepFailureReason;
  readonly stepIndex: number | null;
  readonly selector: string | undefined;
  readonly matchCount: number | undefined;

  constructor(
    operation: CapturePlanOperation,
    stepIndex: number | null,
    cause: unknown,
    details: {
      readonly reason: StepFailureReason;
      readonly selector?: string;
      readonly matchCount?: number;
    },
  ) {
    const location =
      stepIndex === null ? "initial navigation" : `step ${stepIndex + 1}`;
    super(`Capture plan ${location} (${operation}) failed`, { cause });
    this.name = "CapturePlanExecutionError";
    this.operation = operation;
    this.reason = details.reason;
    this.stepIndex = stepIndex;
    this.selector = details.selector;
    this.matchCount = details.matchCount;
  }
}

function stepSelectors(step: CaptureStep) {
  if (step.action === "drag") {
    return [step.source_selector, step.target_selector];
  }
  if ("selector" in step && step.selector !== undefined) {
    return [step.selector];
  }
  return [];
}

async function locatorCount(page: Page, selector: string) {
  try {
    return await page.locator(selector).count();
  } catch {
    return undefined;
  }
}

async function diagnoseStepFailure(
  page: Page,
  step: CaptureStep,
  error: unknown,
) {
  for (const selector of stepSelectors(step)) {
    const matchCount = await locatorCount(page, selector);
    if (matchCount === 0) {
      return {
        matchCount,
        reason: "selector_not_found" as const,
        selector,
      };
    }
    if (matchCount !== undefined && matchCount > 1) {
      return {
        matchCount,
        reason: "selector_not_unique" as const,
        selector,
      };
    }
  }

  if (step.action === "goto") {
    return { reason: "navigation_failed" as const };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { reason: "step_timeout" as const };
  }
  return { reason: "step_failed" as const };
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
  let currentOperation: CapturePlanOperation = "start_url";
  let currentStepIndex: number | null = null;
  const durationTimer = setTimeout(
    () =>
      durationController.abort(
        new CapturePlanDurationError(
          plan.max_duration_ms,
          currentOperation,
          currentStepIndex,
        ),
      ),
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
        throw durationController.signal.reason;
      }
      throw new CapturePlanExecutionError("start_url", null, error, {
        reason: "navigation_failed",
      });
    }

    for (const [stepIndex, step] of plan.steps.entries()) {
      currentOperation = step.action;
      currentStepIndex = stepIndex;
      try {
        await executeStep(page, step, durationController.signal);
      } catch (error) {
        if (durationController.signal.aborted) {
          throw durationController.signal.reason;
        }
        throw new CapturePlanExecutionError(
          step.action,
          stepIndex,
          error,
          await diagnoseStepFailure(page, step, error),
        );
      }
    }
  } finally {
    clearTimeout(durationTimer);
  }
}
