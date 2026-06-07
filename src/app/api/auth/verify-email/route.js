import { NextResponse } from "next/server";
import { peekEmailVerifyToken, removeEmailVerifyToken } from "@/lib/auth/emailVerifyToken.js";
import { updateUser } from "@/lib/db/index.js";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    if (!token) {
      return NextResponse.json(
        { error: "Invalid or expired verification link" },
        { status: 400 }
      );
    }

    // Validate WITHOUT consuming yet — so a failed/no-op update doesn't burn the
    // one-time token (the user could otherwise never verify with that link).
    const data = await peekEmailVerifyToken(token);
    if (!data) {
      return NextResponse.json(
        { error: "Invalid or expired verification link" },
        { status: 400 }
      );
    }

    const updated = await updateUser(data.userId, { isEmailVerified: true });
    if (!updated) {
      // User no longer exists (deleted mid-flow) — do NOT report success.
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Update committed → now consume the token (one-time use).
    await removeEmailVerifyToken(token);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[verify-email] error:", error.message);
    return NextResponse.json(
      { error: "Verification failed" },
      { status: 500 }
    );
  }
}
