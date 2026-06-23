import { redirect } from "next/navigation";

// Must NOT be statically prerendered: the middleware (dashboardGuard) decides
// where `/` goes (landing vs dashboard) per-request based on the session. A
// prerendered + CDN-cached `/` (s-maxage=1y) would shadow that redirect and
// pin every visitor to one destination. force-dynamic keeps `/` uncached so
// the middleware always runs. This redirect is only a fallback if middleware
// is bypassed.
export const dynamic = "force-dynamic";

export default function InitPage() {
  redirect('/landing');
}
