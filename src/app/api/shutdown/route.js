import { NextResponse } from "next/server";
import { headers } from "next/headers";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ success: false, message: "Not allowed in production" }, { status: 403 });
  }

  const secret = process.env.SHUTDOWN_SECRET;
  // R4-P1-4: headers() is async in Next.js 15 — must await or it returns a
  // Promise object, making .get() always return undefined → endpoint always 401.
  const headersList = await headers();
  const authorization = headersList.get("authorization");

  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const response = NextResponse.json({ success: true, message: "Shutting down..." });

  setTimeout(() => {
    process.exit(0);
  }, 500);

  return response;
}

