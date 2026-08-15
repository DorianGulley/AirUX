import { z } from "zod";

import { utcTimestampSchema } from "./common.js";
import { CONTRACT_LIMITS } from "./limits.js";

const uuidSchema = z.uuid();

export const agentCredentialNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONTRACT_LIMITS.agentCredentialNameLength);

export const agentCredentialTokenSchema = z
  .string()
  .regex(
    /^airux_agent_v1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/,
  );

export const agentCredentialSchema = z
  .object({
    id: uuidSchema,
    name: agentCredentialNameSchema,
    created_at: utcTimestampSchema,
    last_used_at: utcTimestampSchema.nullable(),
    revoked_at: utcTimestampSchema.nullable(),
  })
  .strict();

export const createAgentCredentialRequestSchema = z
  .object({ name: agentCredentialNameSchema })
  .strict();

export const createAgentCredentialResponseSchema = z
  .object({
    credential: agentCredentialSchema,
    token: agentCredentialTokenSchema,
  })
  .strict();

export const listAgentCredentialsResponseSchema = z
  .object({ credentials: z.array(agentCredentialSchema) })
  .strict();

export const revokeAgentCredentialResponseSchema = z
  .object({ credential: agentCredentialSchema })
  .strict();

export type AgentCredential = z.infer<typeof agentCredentialSchema>;
export type CreateAgentCredentialRequest = z.infer<
  typeof createAgentCredentialRequestSchema
>;
export type CreateAgentCredentialResponse = z.infer<
  typeof createAgentCredentialResponseSchema
>;
export type ListAgentCredentialsResponse = z.infer<
  typeof listAgentCredentialsResponseSchema
>;
export type RevokeAgentCredentialResponse = z.infer<
  typeof revokeAgentCredentialResponseSchema
>;
