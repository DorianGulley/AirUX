export type DashboardTab = "reviews" | "credentials" | "account";

export interface DashboardRoute {
  readonly tab: DashboardTab;
}

const DASHBOARD_ROUTES: Readonly<Record<string, DashboardTab>> = {
  "/reviews": "reviews",
  "/reviews/": "reviews",
  "/credentials": "credentials",
  "/credentials/": "credentials",
  "/account": "account",
  "/account/": "account",
};

export function matchDashboardRoute(pathname: string): DashboardRoute | null {
  const tab = DASHBOARD_ROUTES[pathname];
  return tab === undefined ? null : { tab };
}

export function getDashboardLandingPath(isSignedIn: boolean) {
  return isSignedIn ? "/reviews" : "/account";
}
