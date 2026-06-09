import { NextResponse } from "next/server";
import { getPricing } from "@/lib/db/repos/pricingRepo";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pricing = await getPricing();
    const models = [];

    for (const [provider, providerModels] of Object.entries(pricing)) {
      for (const [model, p] of Object.entries(providerModels)) {
        models.push({
          model,
          provider,
          input: p.input ?? 0,
          output: p.output ?? 0,
          cached: p.cached ?? 0,
          reasoning: p.reasoning ?? 0,
          cacheCreation: p.cache_creation ?? p.cacheCreation ?? 0,
        });
      }
    }

    return NextResponse.json({ models }, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (err) {
    console.error("[API] /api/public/models error:", err);
    return NextResponse.json({ error: "Failed to load models" }, { status: 500 });
  }
}
