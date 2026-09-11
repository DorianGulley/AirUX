import { describe, expect, it } from "vitest";

import {
  getDashboardLandingPath,
  getDashboardNavigationPath,
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

  it.each([
    ["/reviews", "/reviews"],
    ["https://airux.example/credentials", "/credentials"],
    ["/account/", "/account/"],
  ])("handles same-origin dashboard navigation to %s", (href, expected) => {
    expect(getDashboardNavigationPath(href, "https://airux.example")).toBe(
      expected,
    );
  });

  it.each([
    "https://other.example/reviews",
    "/reviews/00000000-0000-4000-8000-000000000001",
    "/reviews?next=true",
    "/credentials#new",
  ])("leaves non-dashboard navigation for %s to the browser", (href) => {
    expect(
      getDashboardNavigationPath(href, "https://airux.example"),
    ).toBeNull();
  });
});
