export interface BrowserConfig {
  readonly supabase: {
    readonly url: string;
    readonly publishable_key: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function parseBrowserConfig(value: unknown): BrowserConfig {
  if (!isRecord(value) || !hasOnlyKeys(value, ["supabase"])) {
    throw new Error("Invalid browser configuration");
  }

  const supabase = value.supabase;
  if (
    !isRecord(supabase) ||
    !hasOnlyKeys(supabase, ["publishable_key", "url"]) ||
    typeof supabase.url !== "string" ||
    typeof supabase.publishable_key !== "string" ||
    !supabase.publishable_key.startsWith("sb_publishable_")
  ) {
    throw new Error("Invalid browser configuration");
  }

  let url: URL;
  try {
    url = new URL(supabase.url);
  } catch {
    throw new Error("Invalid browser configuration");
  }

  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  const isOriginOnly =
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";

  if ((url.protocol !== "https:" && !isLocalHttp) || !isOriginOnly) {
    throw new Error("Invalid browser configuration");
  }

  return {
    supabase: {
      url: url.origin,
      publishable_key: supabase.publishable_key,
    },
  };
}

export async function loadBrowserConfig(
  fetchConfig: typeof fetch = globalThis.fetch,
) {
  const response = await fetchConfig("/api/v1/config", {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("Browser configuration unavailable");
  }

  return parseBrowserConfig(await response.json());
}
