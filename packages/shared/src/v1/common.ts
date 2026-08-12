import { z } from "zod";

import { CONTRACT_LIMITS } from "./limits.js";

export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONTRACT_LIMITS.identifierLength);

export const utcTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Timestamp must use UTC (Z)");

export const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const positiveIntegerSchema = z.number().int().positive();
