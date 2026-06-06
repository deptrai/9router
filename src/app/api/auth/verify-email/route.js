import { NextResponse } from "next/server";
import { consumeEmailVerifyToken } from "@/lib/auth/emailVerifyToken.js";
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

    const data = await consumeEmailVerifyToken(token);
    if (!data) {
      return NextResponse.json(
        { error: "Invalid or expired verification link" },
        { status: 400 }
      );
    }

    await updateUser(data.userId, { isEmailVerified: true });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[verify-email] error:", error.message);
    return NextResponse.json(
      { error: "Verification failed" },
      { status: 500 }
    );
  }
}
