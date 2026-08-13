const HEALTH_PATH = "/api/v1/health";

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...jsonHeaders,
      ...headers,
    },
  });
}

const worker = {
  fetch(request: Request) {
    const { pathname } = new URL(request.url);

    if (pathname === HEALTH_PATH) {
      if (request.method !== "GET") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "GET" },
        );
      }

      return jsonResponse({ status: "ok" });
    }

    return jsonResponse(
      {
        error: {
          code: "not_found",
          message: "Not found",
        },
      },
      404,
    );
  },

  scheduled() {
    // Cleanup work is introduced in M6-5.
  },
} satisfies ExportedHandler<Env>;

export default worker;
