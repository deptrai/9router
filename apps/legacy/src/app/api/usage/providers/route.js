import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/requestDetailsDb";
import { getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";
import { getSessionRole } from "@/lib/auth/requireRole";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/providers
 * Returns list of unique providers from request details
 */
export async function GET(request) {
  try {
    const { session } = await getSessionRole(request);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { details } = await getRequestDetails({ pageSize: 9999 });

    const providerIds = [...new Set(details.map(r => r.provider).filter(Boolean))].sort();

    const providerNodes = await getProviderNodes();
    const nodeMap = {};
    for (const node of providerNodes) {
      nodeMap[node.id] = node.name;
    }

    const providers = providerIds.map(providerId => {
      let name = providerId;
      if (nodeMap[providerId]) {
        name = nodeMap[providerId];
      } else {
        const providerConfig = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
        if (providerConfig?.name) name = providerConfig.name;
      }
      return { id: providerId, name };
    });

    return NextResponse.json({ providers });
  } catch (error) {
    console.error("[API] Failed to get providers:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}
