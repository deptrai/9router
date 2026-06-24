import { NextResponse } from "next/server";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { requireAdmin } from "@/lib/auth/requireRole";

export async function POST(request) {
  try {
    // R4-P0-4: proxy-test makes outbound HTTP to arbitrary URLs (SSRF risk).
    // Require admin regardless of requireLogin setting.
    const session = await requireAdmin(request);
    if (!session) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const result = await testProxyUrl({
      proxyUrl: body?.proxyUrl,
      testUrl: body?.testUrl,
      timeoutMs: body?.timeoutMs,
    });

    if (result?.ok) {
      return NextResponse.json(result);
    }

    const status = typeof result?.status === "number" ? result.status : 500;
    return NextResponse.json({ ok: false, error: result?.error || "Proxy test failed" }, { status });
  } catch (err) {
    const message = err?.name === "AbortError" ? "Proxy test timed out" : (err?.message || String(err));
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
