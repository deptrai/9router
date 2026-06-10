import { NextResponse } from "next/server";
import { getApiKeys, getApiKeysByUser, createApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

async function getSession() {
  const cookieStore = await cookies();
  return getDashboardAuthSession(cookieStore.get("auth_token")?.value);
}

// GET /api/keys - List API keys (role-aware)
export async function GET() {
  try {
    const session = await getSession();
    const role = session?.role ?? "admin";

    const keys =
      role === "user" && session?.userId
        ? await getApiKeysByUser(session.userId)
        : await getApiKeys();

    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key (role-aware + ownership)
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, description, creditLimit: rawLimit } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate creditLimit: null/undefined/blank = unlimited, number >= 0 = capped.
    // Review patch (P1): trim strings first so whitespace-only ("  ") is treated as
    // blank (unlimited), not Number("  ")===0 which would create a permanently-blocked key.
    let creditLimit = null;
    const trimmedLimit = typeof rawLimit === "string" ? rawLimit.trim() : rawLimit;
    if (trimmedLimit !== undefined && trimmedLimit !== null && trimmedLimit !== "") {
      const parsed = Number(trimmedLimit);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return NextResponse.json({ error: "creditLimit must be >= 0" }, { status: 400 });
      }
      creditLimit = parsed;
    }

    const session = await getSession();
    const role = session?.role ?? "admin";

    // Attach userId for user role; admin keys have no owner
    const userId = role === "user" ? (session?.userId ?? null) : null;

    // Always get machineId from server
    const machineId = await getConsistentMachineId();

    let apiKey;
    try {
      apiKey = await createApiKey(name, machineId, userId, description ?? null, creditLimit);
    } catch (err) {
      if (err.code === "KEY_LIMIT") {
        return NextResponse.json(
          { error: "Đã đạt giới hạn 10 keys" },
          { status: 400 }
        );
      }
      throw err;
    }

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      userId: apiKey.userId,
      description: apiKey.description,
      creditLimit: apiKey.creditLimit,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
