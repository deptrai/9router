import { proxy as dashboardGuardProxy } from "./dashboardGuard";

export function proxy(request) {
  return dashboardGuardProxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
