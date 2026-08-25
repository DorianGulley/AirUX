export interface ScheduledCleanupMetrics {
  readonly selected: number;
  readonly deleted: number;
  readonly failed: number;
}

export type ScheduledCleanupFailureStage = "configuration" | "execution";

export function recordScheduledCleanupCompleted(
  metrics: ScheduledCleanupMetrics,
) {
  console.info({
    event: "scheduled_cleanup_completed",
    ...metrics,
  });
}

export function recordScheduledCleanupFailed(
  stage: ScheduledCleanupFailureStage,
  metrics: ScheduledCleanupMetrics,
) {
  console.error({
    event: "scheduled_cleanup_failed",
    stage,
    ...metrics,
  });
}
