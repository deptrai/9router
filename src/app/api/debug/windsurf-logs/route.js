import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

// GET /api/debug/windsurf-logs — list raw windsurf response logs
// GET /api/debug/windsurf-logs?id=<filename> — get specific log
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    // Auth bypass via secret token for debug access
    const token = searchParams.get("token");
    if (token !== "debug-9router-2026") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const logDir = "/app/data/debug";
    const id = searchParams.get("id");

    if (!fs.existsSync(logDir)) {
      return NextResponse.json({ logs: [], message: "No debug logs yet" });
    }

    if (id) {
      const logFile = path.join(logDir, id);
      if (!fs.existsSync(logFile)) {
        return NextResponse.json({ error: "Log not found" }, { status: 404 });
      }
      const content = fs.readFileSync(logFile, "utf-8");
      return new Response(content, {
        headers: { "Content-Type": "application/json" },
      });
    }

    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith("windsurf-raw-") && f.endsWith(".json"))
      .sort().reverse().slice(0, 20);

    const logs = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(logDir, f), "utf-8"));
        return {
          filename: f,
          timestamp: data.timestamp,
          model: data.model,
          toolDefsCount: data.toolDefsCount,
          toolDefsNames: data.toolDefsNames,
          rawResponsePreview: (data.rawResponse || "").slice(0, 300),
          rawResponseLength: (data.rawResponse || "").length,
        };
      } catch {
        return { filename: f, error: "parse failed" };
      }
    });

    return NextResponse.json({ logs });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
