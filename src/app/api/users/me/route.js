import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getUserById, getUserByEmail, updateUser } from "@/lib/db/index.js";

async function getSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session || session.role !== "user") {
    return null;
  }
  return session;
}

export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Forbidden — user role required" }, { status: 403 });
  }

  const user = await getUserById(session.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    creditsBalance: user.creditsBalance,
    isEmailVerified: user.isEmailVerified,
    allowCreditOverflow: user.allowCreditOverflow ?? false,
    planId: user.planId ?? null,
    planExpiresAt: user.planExpiresAt ?? null,
    createdAt: user.createdAt,
  });
}

export async function PATCH(request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Forbidden — user role required" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { displayName, currentPassword, newPassword, allowCreditOverflow } = body;

    // Password change flow
    if (currentPassword || newPassword) {
      if (!currentPassword || !newPassword) {
        return NextResponse.json(
          { error: "Both currentPassword and newPassword are required" },
          { status: 400 }
        );
      }
      if (newPassword.length < 8) {
        return NextResponse.json(
          { error: "New password must be at least 8 characters" },
          { status: 400 }
        );
      }

      // Need passwordHash for comparison — use getUserByEmail
      const userFull = await getUserByEmail(session.email);
      if (!userFull) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      const valid = await bcrypt.compare(currentPassword, userFull.passwordHash);
      if (!valid) {
        return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await updateUser(session.userId, { passwordHash: newHash });
      return NextResponse.json({ success: true, message: "Password updated" });
    }

    // allowCreditOverflow toggle
    if (allowCreditOverflow !== undefined) {
      if (typeof allowCreditOverflow !== "boolean") {
        return NextResponse.json({ error: "allowCreditOverflow must be a boolean" }, { status: 400 });
      }
      const updated = await updateUser(session.userId, { allowCreditOverflow });
      if (!updated) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }
      return NextResponse.json({
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        creditsBalance: updated.creditsBalance,
        isEmailVerified: updated.isEmailVerified,
        allowCreditOverflow: updated.allowCreditOverflow ?? false,
        createdAt: updated.createdAt,
      });
    }

    // Display name update
    if (displayName !== undefined) {
      const updated = await updateUser(session.userId, { displayName });
      if (!updated) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }
      return NextResponse.json({
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        creditsBalance: updated.creditsBalance,
        isEmailVerified: updated.isEmailVerified,
        allowCreditOverflow: updated.allowCreditOverflow ?? false,
        createdAt: updated.createdAt,
      });
    }

    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Update failed" }, { status: 500 });
  }
}
