import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { cookies } from "next/headers";

async function getSession() {
  const cookieStore = await cookies();
  return getDashboardAuthSession(cookieStore.get("auth_token")?.value);
}

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;

    // R4-P0-1: require a valid session before exposing key details.
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    // Ownership check for user role — users can only read their own keys.
    const role = session.role ?? "admin";
    if (role === "user" && key.userId !== session.userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key (ownership guard)
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, description, name, creditLimit: rawLimit } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    // Ownership check: require a valid session first.
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const role = session.role ?? "admin"; // legacy token without role → admin
    if (role === "user" && existing.userId !== session.userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (description !== undefined) updateData.description = description;
    if (name !== undefined) updateData.name = name;
    if (rawLimit !== undefined) {
      // Review patch (P1): trim strings so whitespace-only is treated as blank (clear → unlimited),
      // not Number("  ")===0 which would create a permanently-blocked key.
      const trimmedLimit = typeof rawLimit === "string" ? rawLimit.trim() : rawLimit;
      if (trimmedLimit === null || trimmedLimit === "") {
        updateData.creditLimit = null;
      } else {
        const parsed = Number(trimmedLimit);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return NextResponse.json({ error: "creditLimit must be >= 0" }, { status: 400 });
        }
        updateData.creditLimit = parsed;
      }
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key (ownership guard)
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    // Ownership check: require a valid session first.
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const role = session.role ?? "admin"; // legacy token without role → admin
    if (role === "user" && existing.userId !== session.userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
