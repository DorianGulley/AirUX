const ENVIRONMENTS = ["local", "development"] as const;

export type AiruxEnvironment = (typeof ENVIRONMENTS)[number];

type ConfigurationBindings = Pick<
  Env,
  | "AIRUX_ENVIRONMENT"
  | "AIRUX_APP_ORIGIN"
  | "SUPABASE_URL"
  | "SUPABASE_PUBLISHABLE_KEY"
  | "SUPABASE_SECRET_KEY"
>;

export interface AiruxConfig {
  readonly environment: AiruxEnvironment;
  readonly appOrigin: string;
  readonly supabase: {
    readonly url: string;
    readonly publishableKey: string;
    readonly secretKey: string;
  };
}

export class ConfigurationError extends Error {
  constructor(bindingName: keyof ConfigurationBindings) {
    super(`Invalid or missing environment binding: ${bindingName}`);
    this.name = "ConfigurationError";
  }
}

function requireEnvironment(value: string): AiruxEnvironment {
  if (
    typeof value !== "string" ||
    !ENVIRONMENTS.includes(value as AiruxEnvironment)
  ) {
    throw new ConfigurationError("AIRUX_ENVIRONMENT");
  }

  return value as AiruxEnvironment;
}

function requireOrigin(
  bindingName: "AIRUX_APP_ORIGIN" | "SUPABASE_URL",
  value: string,
  environment: AiruxEnvironment,
) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(bindingName);
  }

  const isOriginOnly =
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  const isAllowedProtocol =
    url.protocol === "https:" ||
    (environment === "local" && url.protocol === "http:");

  if (!isOriginOnly || !isAllowedProtocol) {
    throw new ConfigurationError(bindingName);
  }

  return url.origin;
}

function requirePrefix(
  bindingName: "SUPABASE_PUBLISHABLE_KEY" | "SUPABASE_SECRET_KEY",
  value: string,
  prefix: string,
) {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length === prefix.length
  ) {
    throw new ConfigurationError(bindingName);
  }

  return value;
}

export function loadConfig(env: ConfigurationBindings): AiruxConfig {
  const environment = requireEnvironment(env.AIRUX_ENVIRONMENT);

  return {
    environment,
    appOrigin: requireOrigin(
      "AIRUX_APP_ORIGIN",
      env.AIRUX_APP_ORIGIN,
      environment,
    ),
    supabase: {
      url: requireOrigin("SUPABASE_URL", env.SUPABASE_URL, environment),
      publishableKey: requirePrefix(
        "SUPABASE_PUBLISHABLE_KEY",
        env.SUPABASE_PUBLISHABLE_KEY,
        "sb_publishable_",
      ),
      secretKey: requirePrefix(
        "SUPABASE_SECRET_KEY",
        env.SUPABASE_SECRET_KEY,
        "sb_secret_",
      ),
    },
  };
}
