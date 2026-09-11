import { describe, expect, it, vi } from "vitest";

import { MemoryResourceCache } from "../src/memory-resource-cache.js";

describe("MemoryResourceCache", () => {
  it("reports fresh and stale cached values without persisting them", async () => {
    let now = 1_000;
    const cache = new MemoryResourceCache<string>(30_000, () => now);

    await expect(cache.load(async () => "reviews")).resolves.toBe("reviews");
    expect(cache.read()).toEqual({ value: "reviews", isFresh: true });

    now = 31_000;
    expect(cache.read()).toEqual({ value: "reviews", isFresh: false });
  });

  it("deduplicates concurrent refreshes", async () => {
    let resolveLoad: ((value: string) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const cache = new MemoryResourceCache<string>(30_000);

    const first = cache.load(loader);
    const second = cache.load(loader);
    resolveLoad?.("credentials");

    await expect(first).resolves.toBe("credentials");
    await expect(second).resolves.toBe("credentials");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does not retain a response completed after the cache is cleared", async () => {
    let resolveLoad: ((value: string) => void) | undefined;
    const cache = new MemoryResourceCache<string>(30_000);
    const pending = cache.load(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    cache.clear();
    resolveLoad?.("other-user-data");

    await expect(pending).resolves.toBeUndefined();
    expect(cache.read()).toBeNull();
  });
});
