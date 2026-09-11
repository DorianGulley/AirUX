import { describe, expect, it } from "vitest";

import {
  getDashboardLandingPath,
  matchDashboardRoute,
} from "../src/app-route.js";

describe("dashboard routes", () => {
  it.each([
    ["/reviews", "reviews"],
    ["/reviews/", "reviews"],
    ["/credentials", "credentials"],
    ["/credentials/", "credentials"],
    ["/account", "account"],
    ["/account/", "account"],
  ] as const)("maps %s to the %s tab", (pathname, tab) => {
    expect(matchDashboardRoute(pathname)).toEqual({ tab });
  });

  it.each(["/", "/reviews/id", "/credentials/extra", "/unknown"])(
    "does not treat %s as a dashboard tab",
    (pathname) => {
      expect(matchDashboardRoute(pathname)).toBeNull();
    },
  );

  it("sends signed-in users to Reviews and signed-out users to Account", () => {
    expect(getDashboardLandingPath(true)).toBe("/reviews");
    expect(getDashboardLandingPath(false)).toBe("/account");
  });
});
