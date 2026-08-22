import { readJsonResponse } from "./bounded-json.js";
import type { AiruxConfig } from "./config.js";

const CLEANUP_BATCH_LIMIT = 25;
const DATA_RESPONSE_LIMIT = 64 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CLEANUP_REVIEW_STATES = new Set([
  "approved",
  "changes_requested",
  "cancelled",
  "expired",
]);

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ScheduledCleanupStreamClient {
  deleteVideo(id: string): Promise<void>;
}

export interface ScheduledCleanupDependencies {
  readonly stream: ScheduledCleanupStreamClient;
  readonly fetcher?: Fetcher;
}

interface DueEvidence {
  readonly evidenceId: string;
  readonly reviewId: string;
  readonly streamVideoId: string | null;
}

export class ScheduledCleanupError extends Error {}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function dataApiHeaders(config: AiruxConfig) {
  return {
    accept: "application/json",
    apikey: config.supabase.secretKey,
    "content-type": "application/json",
  };
}

async function callRpc(
  name: string,
  body: Record<string, unknown>,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  let response: Response;
  try {
    response = await fetcher(
      new URL(`/rest/v1/rpc/${name}`, config.supabase.url),
      {
        method: "POST",
        headers: dataApiHeaders(config),
        body: JSON.stringify(body),
        redirect: "manual",
      },
    );
  } catch {
    throw new ScheduledCleanupError();
  }
  if (!response.ok) {
    throw new ScheduledCleanupError();
  }

  try {
    const rows = await readJsonResponse(response, DATA_RESPONSE_LIMIT);
    if (!Array.isArray(rows)) {
      throw new ScheduledCleanupError();
    }
    return rows;
  } catch (error) {
    if (error instanceof ScheduledCleanupError) {
      throw error;
    }
    throw new ScheduledCleanupError();
  }
}

function normalizeDueEvidence(rows: unknown[]) {
  if (rows.length > CLEANUP_BATCH_LIMIT) {
    throw new ScheduledCleanupError();
  }

  const evidenceIds = new Set<string>();
  const streamVideoIds = new Set<string>();
  return rows.map((value): DueEvidence => {
    const row = asRecord(value);
    if (
      row === null ||
      typeof row.evidence_id !== "string" ||
      !UUID_PATTERN.test(row.evidence_id) ||
      evidenceIds.has(row.evidence_id) ||
      typeof row.review_id !== "string" ||
      !UUID_PATTERN.test(row.review_id) ||
      row.evidence_status !== "deleting" ||
      typeof row.review_status !== "string" ||
      !CLEANUP_REVIEW_STATES.has(row.review_status) ||
      (row.stream_video_id !== null &&
        (typeof row.stream_video_id !== "string" ||
          !STREAM_VIDEO_ID_PATTERN.test(row.stream_video_id) ||
          streamVideoIds.has(row.stream_video_id)))
    ) {
      throw new ScheduledCleanupError();
    }
    evidenceIds.add(row.evidence_id);
    if (typeof row.stream_video_id === "string") {
      streamVideoIds.add(row.stream_video_id);
    }
    return {
      evidenceId: row.evidence_id,
      reviewId: row.review_id,
      streamVideoId: row.stream_video_id,
    };
  });
}

async function prepareDueEvidence(
  dueBefore: string,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  return normalizeDueEvidence(
    await callRpc(
      "prepare_due_evidence_cleanup",
      { p_due_before: dueBefore, p_limit: CLEANUP_BATCH_LIMIT },
      config,
      fetcher,
    ),
  );
}

async function recordDeletion(
  evidence: DueEvidence,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  const rows = await callRpc(
    "complete_evidence_cleanup",
    {
      p_evidence_id: evidence.evidenceId,
      p_stream_video_id: evidence.streamVideoId,
    },
    config,
    fetcher,
  );
  const row = asRecord(rows[0]);
  if (
    rows.length !== 1 ||
    row === null ||
    row.evidence_id !== evidence.evidenceId ||
    row.review_id !== evidence.reviewId ||
    row.status !== "deleted" ||
    typeof row.deleted_at !== "string" ||
    Number.isNaN(new Date(row.deleted_at).getTime())
  ) {
    throw new ScheduledCleanupError();
  }
}

export async function runScheduledCleanup(
  config: AiruxConfig,
  dependencies: ScheduledCleanupDependencies,
  now = new Date(),
) {
  if (Number.isNaN(now.getTime())) {
    throw new ScheduledCleanupError();
  }
  const fetcher = dependencies.fetcher ?? fetch;
  const evidenceRows = await prepareDueEvidence(
    now.toISOString(),
    config,
    fetcher,
  );
  let deleted = 0;
  let failed = 0;

  for (const evidence of evidenceRows) {
    try {
      if (evidence.streamVideoId !== null) {
        await dependencies.stream.deleteVideo(evidence.streamVideoId);
      }
      await recordDeletion(evidence, config, fetcher);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }

  if (failed > 0) {
    throw new ScheduledCleanupError();
  }
  return { selected: evidenceRows.length, deleted };
}
