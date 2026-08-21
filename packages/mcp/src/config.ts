import { agentCredentialTokenSchema } from "@airux/shared/v1";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface AiruxRuntimeConfig {
  readonly apiOrigin: string;
  readonly agentToken: string;
}

export class AiruxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiruxConfigError";
  }
}

function parseApiOrigin(value: string | undefined) {
  if (value === undefined || value.trim().length === 0) {
    throw new AiruxConfigError("AIRUX_API_ORIGIN is required");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiruxConfigError("AIRUX_API_ORIGIN must be a valid URL");
  }

  const isSecure = url.protocol === "https:";
  const isLoopbackHttp =
    url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (
    (!isSecure && !isLoopbackHttp) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AiruxConfigError(
      "AIRUX_API_ORIGIN must be an HTTPS origin or an HTTP loopback origin",
    );
  }

  return url.origin;
}

export function loadAiruxRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AiruxRuntimeConfig {
  const agentToken = environment.AIRUX_AGENT_TOKEN;
  const parsedToken = agentCredentialTokenSchema.safeParse(agentToken);
  if (!parsedToken.success) {
    throw new AiruxConfigError("AIRUX_AGENT_TOKEN is missing or invalid");
  }

  return {
    apiOrigin: parseApiOrigin(environment.AIRUX_API_ORIGIN),
    agentToken: parsedToken.data,
  };
}
