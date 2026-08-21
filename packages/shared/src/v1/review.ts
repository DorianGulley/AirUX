import { z } from "zod";
import { capturePlanSchema } from "./capture.js";
import {
  identifierSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  utcTimestampSchema,
} from "./common.js";
import { CONTRACT_LIMITS } from "./limits.js";

export const REVIEW_STATES = [
  "draft",
  "pending",
  "approved",
  "changes_requested",
  "cancelled",
  "expired",
] as const;

export const EVIDENCE_STATES = [
  "awaiting_upload",
  "processing",
  "ready",
  "failed",
  "deleting",
  "deleted",
] as const;

export const DECISION_OUTCOMES = ["approved", "changes_requested"] as const;

export const EVIDENCE_KINDS = ["browser_video"] as const;

export const reviewStateSchema = z.enum(REVIEW_STATES);
export const evidenceStateSchema = z.enum(EVIDENCE_STATES);
export const decisionOutcomeSchema = z.enum(DECISION_OUTCOMES);
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);

export const reviewCriterionSchema = z
  .object({
    id: z.string().trim().min(1).max(CONTRACT_LIMITS.criterionIdLength),
    prompt: z.string().trim().min(1).max(CONTRACT_LIMITS.criterionPromptLength),
  })
  .strict();

export const reviewCriteriaSchema = z
  .array(reviewCriterionSchema)
  .min(1)
  .max(CONTRACT_LIMITS.criteriaCount)
  .superRefine((criteria, context) => {
    const ids = new Set<string>();

    for (const [index, criterion] of criteria.entries()) {
      if (ids.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          message: "Criterion IDs must be unique",
          path: [index, "id"],
        });
      }
      ids.add(criterion.id);
    }
  });

export const browserVideoEvidenceInputSchema = z
  .object({
    kind: z.literal("browser_video"),
    media_type: z
      .string()
      .regex(/^video\/[a-z0-9][a-z0-9.+-]*$/i, "Expected a video media type"),
    size_bytes: positiveIntegerSchema.max(CONTRACT_LIMITS.mediaSizeBytes),
  })
  .strict();

export const createReviewRequestSchema = z
  .object({
    client_request_id: z
      .string()
      .trim()
      .min(1)
      .max(CONTRACT_LIMITS.clientRequestIdLength),
    title: z.string().trim().min(1).max(CONTRACT_LIMITS.titleLength),
    claim: z.string().trim().min(1).max(CONTRACT_LIMITS.claimLength),
    criteria: reviewCriteriaSchema,
    evidence: browserVideoEvidenceInputSchema,
  })
  .strict();

export const createReviewResponseSchema = z
  .object({
    review_id: identifierSchema,
    review_url: z.url(),
    status: z.literal("draft"),
    evidence_id: identifierSchema,
    upload_url: z.url(),
    upload_expires_at: utcTimestampSchema,
  })
  .strict();

export const createReviewToolInputSchema = createReviewRequestSchema
  .omit({ evidence: true })
  .extend({ capture_plan: capturePlanSchema })
  .strict();

export const createReviewToolOutputSchema = z
  .object({
    review_id: identifierSchema,
    review_url: z.url(),
    status: z.literal("pending"),
  })
  .strict();

export const getReviewToolInputSchema = z
  .object({ review_id: identifierSchema })
  .strict();

export const agentReviewEvidenceSchema = z
  .object({
    id: identifierSchema,
    kind: evidenceKindSchema,
    status: evidenceStateSchema,
    media_type: z
      .string()
      .regex(/^video\/[a-z0-9][a-z0-9.+-]*$/i, "Expected a video media type"),
    size_bytes: positiveIntegerSchema.max(CONTRACT_LIMITS.mediaSizeBytes),
    failure_code: z.string().trim().min(1).max(128).nullable(),
  })
  .strict();

export const agentReviewDecisionSchema = z
  .object({
    outcome: decisionOutcomeSchema,
    comment: z
      .string()
      .trim()
      .min(1)
      .max(CONTRACT_LIMITS.commentLength)
      .nullable(),
    created_at: utcTimestampSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.outcome === "changes_requested" && decision.comment === null) {
      context.addIssue({
        code: "custom",
        message: "A comment is required when requesting changes",
        path: ["comment"],
      });
    }
  });

export const getReviewToolOutputSchema = z
  .object({
    review_id: identifierSchema,
    review_url: z.url(),
    status: z.enum(["approved", "changes_requested", "cancelled", "expired"]),
    decision: agentReviewDecisionSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const decided =
      result.status === "approved" || result.status === "changes_requested";
    if (decided && result.decision?.outcome !== result.status) {
      context.addIssue({
        code: "custom",
        message: "A decided Review requires its matching Decision",
        path: ["decision"],
      });
    }
    if (!decided && result.decision !== null) {
      context.addIssue({
        code: "custom",
        message: "An undecided terminal Review cannot include a Decision",
        path: ["decision"],
      });
    }
  });

export const agentReviewSummarySchema = z
  .object({
    id: identifierSchema,
    review_url: z.url(),
    client_request_id: z
      .string()
      .trim()
      .min(1)
      .max(CONTRACT_LIMITS.clientRequestIdLength),
    title: z.string().trim().min(1).max(CONTRACT_LIMITS.titleLength),
    status: z.enum(["draft", "pending"]),
    version: nonNegativeIntegerSchema,
    created_at: utcTimestampSchema,
    expires_at: utcTimestampSchema,
  })
  .strict();

export const agentReviewSchema = z
  .object({
    id: identifierSchema,
    review_url: z.url(),
    client_request_id: z
      .string()
      .trim()
      .min(1)
      .max(CONTRACT_LIMITS.clientRequestIdLength),
    title: z.string().trim().min(1).max(CONTRACT_LIMITS.titleLength),
    claim: z.string().trim().min(1).max(CONTRACT_LIMITS.claimLength),
    criteria: reviewCriteriaSchema,
    status: reviewStateSchema,
    version: nonNegativeIntegerSchema,
    created_at: utcTimestampSchema,
    submitted_at: utcTimestampSchema.nullable(),
    expires_at: utcTimestampSchema,
    resolved_at: utcTimestampSchema.nullable(),
    evidence: agentReviewEvidenceSchema,
    decision: agentReviewDecisionSchema.nullable(),
  })
  .strict();

export const getAgentReviewResponseSchema = z
  .object({ review: agentReviewSchema })
  .strict();

export const listOpenAgentReviewsResponseSchema = z
  .object({ reviews: z.array(agentReviewSummarySchema) })
  .strict();

export const listOpenReviewsToolInputSchema = z.object({}).strict();
export const listOpenReviewsToolOutputSchema =
  listOpenAgentReviewsResponseSchema;

export const cancelAgentReviewResponseSchema = getAgentReviewResponseSchema;

export const reviewerReviewEvidenceSchema = z
  .object({
    id: identifierSchema,
    kind: evidenceKindSchema,
    status: evidenceStateSchema,
    media_type: z
      .string()
      .regex(/^video\/[a-z0-9][a-z0-9.+-]*$/i, "Expected a video media type"),
    size_bytes: positiveIntegerSchema.max(CONTRACT_LIMITS.mediaSizeBytes),
    duration_ms: positiveIntegerSchema
      .max(CONTRACT_LIMITS.captureDurationMs)
      .nullable(),
    width: positiveIntegerSchema
      .max(CONTRACT_LIMITS.viewportWidth.max)
      .nullable(),
    height: positiveIntegerSchema
      .max(CONTRACT_LIMITS.viewportHeight.max)
      .nullable(),
    failure_code: z.string().trim().min(1).max(128).nullable(),
  })
  .strict();

export const reviewerReviewDecisionSchema = agentReviewDecisionSchema;

export const reviewerReviewSchema = z
  .object({
    id: identifierSchema,
    title: z.string().trim().min(1).max(CONTRACT_LIMITS.titleLength),
    claim: z.string().trim().min(1).max(CONTRACT_LIMITS.claimLength),
    criteria: reviewCriteriaSchema,
    status: reviewStateSchema,
    version: nonNegativeIntegerSchema,
    created_at: utcTimestampSchema,
    submitted_at: utcTimestampSchema.nullable(),
    expires_at: utcTimestampSchema,
    resolved_at: utcTimestampSchema.nullable(),
    evidence: reviewerReviewEvidenceSchema,
    decision: reviewerReviewDecisionSchema.nullable(),
  })
  .strict();

export const getReviewerReviewResponseSchema = z
  .object({ review: reviewerReviewSchema })
  .strict();

export const decideReviewerReviewResponseSchema =
  getReviewerReviewResponseSchema;

export const streamPlaybackSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(8_192)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    player_url: z.url(),
    expires_at: utcTimestampSchema,
  })
  .strict()
  .superRefine((playback, context) => {
    const match = playback.player_url.match(
      /^https:\/\/customer-[a-z0-9]+\.cloudflarestream\.com\/([^/?#]+)\/iframe$/,
    );
    if (match?.[1] !== playback.token) {
      context.addIssue({
        code: "custom",
        message: "Expected a Cloudflare Stream player URL",
        path: ["player_url"],
      });
    }
  });

export const createPlaybackTokenResponseSchema = z
  .object({ playback: streamPlaybackSchema })
  .strict();

export const decisionRequestSchema = z
  .object({
    expected_version: nonNegativeIntegerSchema,
    outcome: decisionOutcomeSchema,
    comment: z
      .string()
      .trim()
      .min(1)
      .max(CONTRACT_LIMITS.commentLength)
      .optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (
      decision.outcome === "changes_requested" &&
      decision.comment === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A comment is required when requesting changes",
        path: ["comment"],
      });
    }
  });

export const reviewSchema = z
  .object({
    id: identifierSchema,
    user_id: identifierSchema,
    agent_credential_id: identifierSchema,
    client_request_id: z
      .string()
      .trim()
      .min(1)
      .max(CONTRACT_LIMITS.clientRequestIdLength),
    title: z.string().trim().min(1).max(CONTRACT_LIMITS.titleLength),
    claim: z.string().trim().min(1).max(CONTRACT_LIMITS.claimLength),
    criteria: reviewCriteriaSchema,
    status: reviewStateSchema,
    version: nonNegativeIntegerSchema,
    created_at: utcTimestampSchema,
    submitted_at: utcTimestampSchema.nullable(),
    expires_at: utcTimestampSchema,
    resolved_at: utcTimestampSchema.nullable(),
    deleted_at: utcTimestampSchema.nullable(),
  })
  .strict();

export const evidenceSchema = z
  .object({
    id: identifierSchema,
    review_id: identifierSchema,
    kind: evidenceKindSchema,
    status: evidenceStateSchema,
    stream_video_id: identifierSchema.nullable(),
    media_type: z
      .string()
      .regex(/^video\/[a-z0-9][a-z0-9.+-]*$/i, "Expected a video media type"),
    size_bytes: positiveIntegerSchema.max(CONTRACT_LIMITS.mediaSizeBytes),
    duration_ms: positiveIntegerSchema
      .max(CONTRACT_LIMITS.captureDurationMs)
      .nullable(),
    width: positiveIntegerSchema
      .max(CONTRACT_LIMITS.viewportWidth.max)
      .nullable(),
    height: positiveIntegerSchema
      .max(CONTRACT_LIMITS.viewportHeight.max)
      .nullable(),
    failure_code: z.string().trim().min(1).max(128).nullable(),
    delete_after: utcTimestampSchema,
    deleted_at: utcTimestampSchema.nullable(),
    created_at: utcTimestampSchema,
  })
  .strict();

export const decisionSchema = z
  .object({
    id: identifierSchema,
    review_id: identifierSchema,
    user_id: identifierSchema,
    outcome: decisionOutcomeSchema,
    comment: z
      .string()
      .trim()
      .min(1)
      .max(CONTRACT_LIMITS.commentLength)
      .nullable(),
    created_at: utcTimestampSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.outcome === "changes_requested" && decision.comment === null) {
      context.addIssue({
        code: "custom",
        message: "A comment is required when requesting changes",
        path: ["comment"],
      });
    }
  });

export type ReviewState = z.infer<typeof reviewStateSchema>;
export type EvidenceState = z.infer<typeof evidenceStateSchema>;
export type DecisionOutcome = z.infer<typeof decisionOutcomeSchema>;
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type ReviewCriterion = z.infer<typeof reviewCriterionSchema>;
export type BrowserVideoEvidenceInput = z.infer<
  typeof browserVideoEvidenceInputSchema
>;
export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>;
export type CreateReviewResponse = z.infer<typeof createReviewResponseSchema>;
export type CreateReviewToolInput = z.infer<typeof createReviewToolInputSchema>;
export type CreateReviewToolOutput = z.infer<
  typeof createReviewToolOutputSchema
>;
export type GetReviewToolInput = z.infer<typeof getReviewToolInputSchema>;
export type GetReviewToolOutput = z.infer<typeof getReviewToolOutputSchema>;
export type AgentReviewEvidence = z.infer<typeof agentReviewEvidenceSchema>;
export type AgentReviewDecision = z.infer<typeof agentReviewDecisionSchema>;
export type AgentReviewSummary = z.infer<typeof agentReviewSummarySchema>;
export type AgentReview = z.infer<typeof agentReviewSchema>;
export type GetAgentReviewResponse = z.infer<
  typeof getAgentReviewResponseSchema
>;
export type ListOpenAgentReviewsResponse = z.infer<
  typeof listOpenAgentReviewsResponseSchema
>;
export type ListOpenReviewsToolInput = z.infer<
  typeof listOpenReviewsToolInputSchema
>;
export type ListOpenReviewsToolOutput = z.infer<
  typeof listOpenReviewsToolOutputSchema
>;
export type CancelAgentReviewResponse = z.infer<
  typeof cancelAgentReviewResponseSchema
>;
export type ReviewerReviewEvidence = z.infer<
  typeof reviewerReviewEvidenceSchema
>;
export type ReviewerReviewDecision = z.infer<
  typeof reviewerReviewDecisionSchema
>;
export type ReviewerReview = z.infer<typeof reviewerReviewSchema>;
export type GetReviewerReviewResponse = z.infer<
  typeof getReviewerReviewResponseSchema
>;
export type DecideReviewerReviewResponse = z.infer<
  typeof decideReviewerReviewResponseSchema
>;
export type StreamPlayback = z.infer<typeof streamPlaybackSchema>;
export type CreatePlaybackTokenResponse = z.infer<
  typeof createPlaybackTokenResponseSchema
>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Decision = z.infer<typeof decisionSchema>;
