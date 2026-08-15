const DEFAULT_BODY_LIMIT = 4_096;

export class InvalidJsonBodyError extends Error {}
export class ResponseBodyError extends Error {}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
) {
  if (body === null) {
    throw new InvalidJsonBodyError();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new InvalidJsonBodyError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (length === 0) {
    throw new InvalidJsonBodyError();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    throw new InvalidJsonBodyError();
  }
}

export async function readJsonRequest(
  request: Request,
  limit = DEFAULT_BODY_LIMIT,
): Promise<unknown> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new InvalidJsonBodyError();
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 1 || length > limit) {
      throw new InvalidJsonBodyError();
    }
  }

  try {
    return JSON.parse(await readBoundedBody(request.body, limit));
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      throw error;
    }
    throw new InvalidJsonBodyError();
  }
}

export async function readJsonResponse(
  response: Response,
  limit: number,
): Promise<unknown> {
  try {
    const text = await readBoundedBody(response.body, limit);
    return JSON.parse(text);
  } catch {
    throw new ResponseBodyError();
  }
}
