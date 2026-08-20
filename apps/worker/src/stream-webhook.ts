import {
  CONTRACT_LIMITS,
  evidenceStateSchema,
  reviewStateSchema,
} from "@airux/shared/v1";

import { jsonResponse } from "./api-response.js";
import { readJsonResponse } from "./bounded-json.js";
import type { AiruxConfig } from "./config.js";

const REQUEST_BODY_LIMIT = 64 * 1024;
const DATA_RESPONSE_LIMIT = 16 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface StreamWebhookDependencies {
  readonly fetcher?: Fetcher;
  readonly now?: () => Date;
}

interface StreamWebhookEvent {
  readonly streamVideoId: string;
  readonly targetStatus: "ready" | "failed";
  readonly failureCode: string | null;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

class StreamWebhookAuthenticationError extends Error {}
class StreamWebhookRequestError extends Error {}
class StreamWebhookServiceError extends Error {}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function parseSignatureHeader(value: string | null) {
  if (value === null) {
    throw new StreamWebhookAuthenticationError();
  }

  let timestamp: string | undefined;
  let signature: string | undefined;
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      throw new StreamWebhookAuthenticationError();
    }
    const name = part.slice(0, separator).trim();
    const fieldValue = part.slice(separator + 1).trim();
    if (name === "time") {
      if (timestamp !== undefined) {
        throw new StreamWebhookAuthenticationError();
      }
      timestamp = fieldValue;
    } else if (name === "sig1") {
      if (signature !== undefined) {
        throw new StreamWebhookAuthenticationError();
      }
      signature = fieldValue;
    }
  }

  if (
    timestamp === undefined ||
    !/^\d{1,16}$/.test(timestamp) ||
    signature === undefined ||
    !SIGNATURE_PATTERN.test(signature)
  ) {
    throw new StreamWebhookAuthenticationError();
  }

  return { timestamp, signature };
}

function validateRequestMetadata(request: Request) {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new StreamWebhookRequestError();
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > REQUEST_BODY_LIMIT
    ) {
      throw new StreamWebhookRequestError();
    }
  }
}

async function readRequestBytes(request: Request) {
  validateRequestMetadata(request);
  if (request.body === null) {
    throw new StreamWebhookRequestError();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > REQUEST_BODY_LIMIT) {
        await reader.cancel();
        throw new StreamWebhookRequestError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (length === 0) {
    throw new StreamWebhookRequestError();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function signatureBytes(signature: string) {
  const bytes = new Uint8Array(signature.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      signature.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

async function verifySignature(
  body: Uint8Array,
  signatureHeader: string | null,
  secret: string,
  now: Date,
) {
  const { timestamp, signature } = parseSignatureHeader(signatureHeader);
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(now.getTime() / 1000) - timestampSeconds) >
      SIGNATURE_TOLERANCE_SECONDS
  ) {
    throw new StreamWebhookAuthenticationError();
  }

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${timestamp}.`);
  const signedBody = new Uint8Array(prefix.length + body.length);
  signedBody.set(prefix);
  signedBody.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes(signature),
    signedBody,
  );
  if (!verified) {
    throw new StreamWebhookAuthenticationError();
  }
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= CONTRACT_LIMITS.identifierLength
  );
}

function failureCode(status: Record<string, unknown>) {
  for (const field of [status.errReasonCode, status.errorReasonCode]) {
    if (
      typeof field === "string" &&
      field === field.trim() &&
      field.length > 0 &&
      field.length <= 128
    ) {
      return field;
    }
  }
  return "ERR_UNKNOWN";
}

function parseEvent(body: Uint8Array): StreamWebhookEvent {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body);
    value = JSON.parse(text);
  } catch {
    throw new StreamWebhookRequestError();
  }

  const event = asRecord(value);
  const status = asRecord(event?.status);
  if (event === null || status === null || !validIdentifier(event.uid)) {
    throw new StreamWebhookRequestError();
  }

  if (status.state === "error") {
    return {
      streamVideoId: event.uid,
      targetStatus: "failed",
      failureCode: failureCode(status),
      durationMs: null,
      width: null,
      height: null,
    };
  }

  const input = asRecord(event.input);
  const durationMs =
    typeof event.duration === "number" && Number.isFinite(event.duration)
      ? Math.round(event.duration * 1000)
      : Number.NaN;
  if (
    status.state !== "ready" ||
    event.readyToStream !== true ||
    input === null ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > CONTRACT_LIMITS.captureDurationMs ||
    !Number.isSafeInteger(input.width) ||
    (input.width as number) < 1 ||
    (input.width as number) > CONTRACT_LIMITS.viewportWidth.max ||
    !Number.isSafeInteger(input.height) ||
    (input.height as number) < 1 ||
    (input.height as number) > CONTRACT_LIMITS.viewportHeight.max
  ) {
    throw new StreamWebhookRequestError();
  }

  return {
    streamVideoId: event.uid,
    targetStatus: "ready",
    failureCode: null,
    durationMs,
    width: input.width as number,
    height: input.height as number,
  };
}

async function processEvent(
  event: StreamWebhookEvent,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  let response: Response;
  try {
    response = await fetcher(
      new URL("/rest/v1/rpc/process_stream_webhook", config.supabase.url),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: config.supabase.secretKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_stream_video_id: event.streamVideoId,
          p_target_status: event.targetStatus,
          p_failure_code: event.failureCode,
          p_duration_ms: event.durationMs,
          p_width: event.width,
          p_height: event.height,
        }),
        redirect: "manual",
      },
    );
  } catch {
    throw new StreamWebhookServiceError();
  }
  if (!response.ok) {
    throw new StreamWebhookServiceError();
  }

  let rows: unknown;
  try {
    rows = await readJsonResponse(response, DATA_RESPONSE_LIMIT);
  } catch {
    throw new StreamWebhookServiceError();
  }
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new StreamWebhookServiceError();
  }
  if (rows.length === 1) {
    const row = asRecord(rows[0]);
    const evidenceStatus = evidenceStateSchema.safeParse(row?.evidence_status);
    const reviewStatus = reviewStateSchema.safeParse(row?.review_status);
    if (
      row === null ||
      typeof row.evidence_id !== "string" ||
      !UUID_PATTERN.test(row.evidence_id) ||
      typeof row.review_id !== "string" ||
      !UUID_PATTERN.test(row.review_id) ||
      !evidenceStatus.success ||
      !reviewStatus.success ||
      typeof row.review_version !== "number" ||
      !Number.isSafeInteger(row.review_version) ||
      row.review_version < 0
    ) {
      throw new StreamWebhookServiceError();
    }
  }
}

function noContentResponse() {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof StreamWebhookAuthenticationError) {
    return jsonResponse(
      {
        error: {
          code: "authentication_required",
          message: "Webhook authentication failed",
        },
      },
      401,
    );
  }
  if (error instanceof StreamWebhookRequestError) {
    return jsonResponse(
      { error: { code: "invalid_request", message: "Invalid request" } },
      400,
    );
  }
  return jsonResponse(
    { error: { code: "internal_error", message: "Service unavailable" } },
    503,
  );
}

export async function handleStreamWebhook(
  request: Request,
  config: AiruxConfig,
  dependencies: StreamWebhookDependencies = {},
) {
  try {
    const now = (dependencies.now ?? (() => new Date()))();
    if (Number.isNaN(now.getTime())) {
      throw new StreamWebhookServiceError();
    }
    const body = await readRequestBytes(request);
    await verifySignature(
      body,
      request.headers.get("webhook-signature"),
      config.stream.webhookSecret,
      now,
    );
    const event = parseEvent(body);
    await processEvent(event, config, dependencies.fetcher ?? fetch);
    return noContentResponse();
  } catch (error) {
    return errorResponse(error);
  }
}
