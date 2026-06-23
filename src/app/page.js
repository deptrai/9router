import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

// MUST be dynamic: the destination depends on the per-request session cookie.
// A Node-runtime proxy (dashboardGuard) does NOT intercept statically
// prerendered pages, so the redirect decision has to live inside the render
// pipeline itself. force-dynamic keeps `/` out of the prerender/full-route
// cache so this runs on every request.
export const dynamic = "force-dynamic";

export default async function RootPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  // Only a valid (signed, unexpired) session goes to the dashboard; everyone
  // else — logged out, expired token, or never logged in — sees the landing page.
  if (token && (await verifyDashboardAuthToken(token))) {
    redirect("/dashboard");
  }
  redirect("/landing");
}
