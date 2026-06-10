import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { peekPasswordResetToken, removePasswordResetToken } from "@/lib/auth/passwordResetToken.js";
import { updateUser } from "@/lib/db/index.js";

export async function POST(request) {
  try {
    const body = await request.json();
    const { token, newPassword } = body;

    if (!token) {
      return NextResponse.json(
        { error: "Invalid or expired reset link" },
        { status: 400 }
      );
    }

    if (!newPassword || newPassword.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    // Peek without consuming — token survives if updateUser fails
    const data = await peekPasswordResetToken(token);
    if (!data) {
      return NextResponse.json(
        { error: "Invalid or expired reset link" },
        { status: 400 }
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await updateUser(data.userId, { passwordHash });

    // Remove token only after successful DB write
    await removePasswordResetToken(token);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[reset-password] error:", error.message);
    return NextResponse.json({ error: "Reset failed" }, { status: 500 });
  }
}
