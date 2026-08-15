export function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}
