import { z } from "zod";

import { CONTRACT_LIMITS } from "./limits.js";

export const API_ERROR_CODES = [
  "invalid_request",
  "authentication_required",
  "not_found",
  "conflict",
  "rate_limited",
  "internal_error",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: z
          .string()
          .trim()
          .min(1)
          .max(CONTRACT_LIMITS.apiErrorMessageLength),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    request_id: z
      .string()
      .trim()
      .min(1)
      .max(CONTRACT_LIMITS.requestIdLength)
      .optional(),
  })
  .strict();

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
