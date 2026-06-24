import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { requireAdmin } from "@/lib/auth/requireRole";

// R4-P1-5: must not be prerender-cached — reads live DB settings.
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const settings = await getSettings();
    const requireLogin = settings.requireLogin !== false;
    const tunnelDashboardAccess = settings.tunnelDashboardAccess !== false;

    // R4-P0-3: tunnelUrl/tailscaleUrl reveal internal network topology.
    // Only expose them to authenticated admins; unauthenticated callers
    // (e.g. the login page) only need the requireLogin flag.
    const session = await requireAdmin(request);
    if (session) {
      const tunnelUrl = settings.tunnelUrl || "";
      const tailscaleUrl = settings.tailscaleUrl || "";
      return NextResponse.json({ requireLogin, tunnelDashboardAccess, tunnelUrl, tailscaleUrl });
    }

    return NextResponse.json({ requireLogin });
  } catch (error) {
    return NextResponse.json({ requireLogin: true }, { status: 200 });
  }
}
