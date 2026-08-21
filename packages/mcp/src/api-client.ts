import {
  type ApiErrorCode,
  apiErrorSchema,
  type CreateReviewRequest,
  type CreateReviewResponse,
  createReviewResponseSchema,
  type GetAgentReviewResponse,
  getAgentReviewResponseSchema,
  type ListOpenAgentReviewsResponse,
  listOpenAgentReviewsResponseSchema,
} from "@airux/shared/v1";

import type { AiruxRuntimeConfig } from "./config.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class AiruxApiError extends Error {
  readonly code: ApiErrorCode | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    message: string,
    details: {
      code?: ApiErrorCode;
      retryAfterMs?: number;
      retryable: boolean;
      status?: number;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AiruxApiError";
    this.code = details.code;
    this.retryAfterMs = details.retryAfterMs;
    this.retryable = details.retryable;
    this.status = details.status;
  }
}

function retryAfterMs(response: Response) {
  const value = response.headers.get("retry-after");
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const retryable =
    response.status === 429 ||
    response.status >= 500 ||
    (response.status >= 200 && response.status < 300);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new AiruxApiError("AirUX returned an oversized response", {
      retryable,
      status: response.status,
    });
  }
  if (response.body === null) {
    return undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        length += result.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new AiruxApiError("AirUX returned an oversized response", {
            retryable,
            status: response.status,
          });
        }
        chunks.push(result.value);
      }
    } catch (error) {
      if (error instanceof AiruxApiError) {
        throw error;
      }
      throw new AiruxApiError(
        "Could not read the AirUX API response",
        { retryable, status: response.status },
        { cause: error },
      );
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AiruxApiError(
      "AirUX returned an invalid JSON response",
      { retryable, status: response.status },
      { cause: error },
    );
  }
}

export class AiruxApiClient {
  readonly #config: AiruxRuntimeConfig;
  readonly #fetcher: Fetcher;

  constructor(config: AiruxRuntimeConfig, fetcher: Fetcher = fetch) {
    this.#config = config;
    this.#fetcher = fetcher;
  }

  async #request(
    path: string,
    init: Omit<RequestInit, "headers" | "redirect">,
    expectedStatuses: ReadonlySet<number>,
  ) {
    const url = new URL(path, this.#config.apiOrigin);
    if (url.origin !== this.#config.apiOrigin) {
      throw new AiruxApiError("Refused an untrusted AirUX API destination", {
        retryable: false,
      });
    }

    let response: Response;
    const requestSignal =
      init.signal === undefined || init.signal === null
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : AbortSignal.any([
            init.signal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ]);
    try {
      response = await this.#fetcher(url, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#config.agentToken}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        redirect: "manual",
        signal: requestSignal,
      });
    } catch (error) {
      throw new AiruxApiError(
        "Could not reach the AirUX API",
        { retryable: !init.signal?.aborted },
        { cause: error },
      );
    }

    const body = await readBoundedJson(response);
    if (!expectedStatuses.has(response.status)) {
      const parsed = apiErrorSchema.safeParse(body);
      const retryDelay = retryAfterMs(response);
      throw new AiruxApiError("AirUX rejected the request", {
        ...(parsed.success ? { code: parsed.data.error.code } : {}),
        ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
      });
    }
    return { body, retryAfterMs: retryAfterMs(response) };
  }

  async createReview(
    request: CreateReviewRequest,
    signal: AbortSignal,
  ): Promise<CreateReviewResponse> {
    const { body } = await this.#request(
      "/api/v1/agent/reviews",
      { body: JSON.stringify(request), method: "POST", signal },
      new Set([200, 201]),
    );
    const parsed = createReviewResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiruxApiError("AirUX returned an invalid creation response", {
        retryable: false,
      });
    }
    return parsed.data;
  }

  async getReview(
    reviewId: string,
    signal: AbortSignal,
  ): Promise<GetAgentReviewResponse> {
    const { review } = await this.getReviewForPolling(reviewId, signal);
    return { review };
  }

  async getReviewForPolling(reviewId: string, signal: AbortSignal) {
    const { body, retryAfterMs: retryDelay } = await this.#request(
      `/api/v1/agent/reviews/${encodeURIComponent(reviewId)}`,
      { method: "GET", signal },
      new Set([200]),
    );
    const parsed = getAgentReviewResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiruxApiError("AirUX returned an invalid review response", {
        retryable: false,
      });
    }
    return {
      review: parsed.data.review,
      ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
    };
  }

  async listOpenReviews(
    signal: AbortSignal,
  ): Promise<ListOpenAgentReviewsResponse> {
    const { body } = await this.#request(
      "/api/v1/agent/reviews",
      { method: "GET", signal },
      new Set([200]),
    );
    const parsed = listOpenAgentReviewsResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiruxApiError("AirUX returned an invalid Review list", {
        retryable: false,
      });
    }
    return parsed.data;
  }
}
