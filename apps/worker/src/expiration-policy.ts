export const EXPIRATION_POLICY = {
  uploadUrlMs: 15 * 60 * 1_000,
  draftReviewMs: 60 * 60 * 1_000,
  pendingReviewMs: 72 * 60 * 60 * 1_000,
  resolvedEvidenceMs: 7 * 24 * 60 * 60 * 1_000,
  playbackTokenSeconds: 15 * 60,
} as const;

export class ExpirationPolicyError extends Error {}

export function calculateExpiration(now: Date, lifetimeMs: number) {
  const timestamp = now.getTime();
  const expiresAt = timestamp + lifetimeMs;
  const expiration = new Date(expiresAt);
  if (
    Number.isNaN(timestamp) ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs <= 0 ||
    !Number.isFinite(expiresAt) ||
    Number.isNaN(expiration.getTime())
  ) {
    throw new ExpirationPolicyError();
  }
  return expiration.toISOString();
}
