import { jsonResponse } from "./api-response.js";
import { type AiruxConfig, loadConfig } from "./config.js";

const HEALTH_PATH = "/api/v1/health";
const CONFIG_PATH = "/api/v1/config";

const worker = {
  fetch(request: Request, env: Env) {
    let config: AiruxConfig;

    try {
      config = loadConfig(env);
    } catch {
      return jsonResponse(
        {
          error: {
            code: "internal_error",
            message: "Service unavailable",
          },
        },
        503,
      );
    }

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

    if (pathname === CONFIG_PATH) {
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

      return jsonResponse({
        supabase: {
          url: config.supabase.url,
          publishable_key: config.supabase.publishableKey,
        },
      });
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
