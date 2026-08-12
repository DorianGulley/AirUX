import { z } from "zod";

import { CONTRACT_LIMITS } from "./limits.js";

const localUrlSchema = z.url({
  protocol: /^https?$/,
  hostname: /^(localhost|127\.0\.0\.1|\[::1\])$/,
  message: "URL must use HTTP(S) and target localhost or a loopback address",
});

const selectorSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONTRACT_LIMITS.selectorLength);

const timeoutSchema = z
  .number()
  .int()
  .positive()
  .max(CONTRACT_LIMITS.timeoutMs)
  .optional();

export const viewportSchema = z
  .object({
    width: z
      .number()
      .int()
      .min(CONTRACT_LIMITS.viewportWidth.min)
      .max(CONTRACT_LIMITS.viewportWidth.max),
    height: z
      .number()
      .int()
      .min(CONTRACT_LIMITS.viewportHeight.min)
      .max(CONTRACT_LIMITS.viewportHeight.max),
  })
  .strict();

export const gotoStepSchema = z
  .object({
    action: z.literal("goto"),
    url: localUrlSchema,
    timeout_ms: timeoutSchema,
  })
  .strict();

export const clickStepSchema = z
  .object({
    action: z.literal("click"),
    selector: selectorSchema,
    timeout_ms: timeoutSchema,
  })
  .strict();

export const fillStepSchema = z
  .object({
    action: z.literal("fill"),
    selector: selectorSchema,
    value: z.string().max(CONTRACT_LIMITS.fillValueLength),
    timeout_ms: timeoutSchema,
  })
  .strict();

export const pressStepSchema = z
  .object({
    action: z.literal("press"),
    selector: selectorSchema,
    key: z.string().trim().min(1).max(CONTRACT_LIMITS.keyLength),
    timeout_ms: timeoutSchema,
  })
  .strict();

export const hoverStepSchema = z
  .object({
    action: z.literal("hover"),
    selector: selectorSchema,
    timeout_ms: timeoutSchema,
  })
  .strict();

export const dragStepSchema = z
  .object({
    action: z.literal("drag"),
    source_selector: selectorSchema,
    target_selector: selectorSchema,
    timeout_ms: timeoutSchema,
  })
  .strict();

export const scrollStepSchema = z
  .object({
    action: z.literal("scroll"),
    selector: selectorSchema.optional(),
    delta_x: z
      .number()
      .int()
      .min(-CONTRACT_LIMITS.scrollDelta)
      .max(CONTRACT_LIMITS.scrollDelta),
    delta_y: z
      .number()
      .int()
      .min(-CONTRACT_LIMITS.scrollDelta)
      .max(CONTRACT_LIMITS.scrollDelta),
  })
  .strict()
  .refine(({ delta_x, delta_y }) => delta_x !== 0 || delta_y !== 0, {
    message: "At least one scroll delta must be non-zero",
  });

export const waitForStepSchema = z
  .object({
    action: z.literal("wait_for"),
    selector: selectorSchema,
    state: z
      .enum(["attached", "detached", "visible", "hidden"])
      .default("visible"),
    timeout_ms: timeoutSchema,
  })
  .strict();

export const pauseStepSchema = z
  .object({
    action: z.literal("pause"),
    duration_ms: z
      .number()
      .int()
      .positive()
      .max(CONTRACT_LIMITS.pauseDurationMs),
  })
  .strict();

export const captureStepSchema = z.discriminatedUnion("action", [
  gotoStepSchema,
  clickStepSchema,
  fillStepSchema,
  pressStepSchema,
  hoverStepSchema,
  dragStepSchema,
  scrollStepSchema,
  waitForStepSchema,
  pauseStepSchema,
]);

export const capturePlanSchema = z
  .object({
    start_url: localUrlSchema,
    viewport: viewportSchema,
    max_duration_ms: z
      .number()
      .int()
      .positive()
      .max(CONTRACT_LIMITS.captureDurationMs),
    steps: z
      .array(captureStepSchema)
      .min(1)
      .max(CONTRACT_LIMITS.captureStepCount),
  })
  .strict();

export type Viewport = z.infer<typeof viewportSchema>;
export type CaptureStep = z.infer<typeof captureStepSchema>;
export type CapturePlan = z.infer<typeof capturePlanSchema>;
