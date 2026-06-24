import { NextResponse } from "next/server";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

// TEMP diagnostic — inspect the running container's build + bypass-Traefik self-fetch.
export async function GET() {
  const req = createRequire(import.meta.url);
  let nextVersion = "unknown";
  try { nextVersion = req("next/package.json").version; } catch {}

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, ".next/server/app"),
    path.join(cwd, ".next/standalone/.next/server/app"),
  ];
  const fsInfo = {};
  for (const dir of candidates) {
    try {
      const files = fs.readdirSync(dir);
      fsInfo[dir] = {
        hasIndexHtml: files.includes("index.html"),
        hasPageEntries: files.filter((f) => f.startsWith("index") || f === "page.js").slice(0, 10),
        landingHtml: files.includes("landing.html"),
      };
    } catch (e) {
      fsInfo[dir] = `ENOENT/${e.code || e.message}`;
    }
  }

  // app-paths-manifest: is /page present? (route exists at app layer)
  let appPaths = {};
  for (const p of [
    path.join(cwd, ".next/server/app-paths-manifest.json"),
    path.join(cwd, ".next/standalone/.next/server/app-paths-manifest.json"),
  ]) {
    try {
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      appPaths[p] = { "/page": m["/page"] || null, "/landing/page": m["/landing/page"] || null };
    } catch (e) {
      appPaths[p] = `ENOENT/${e.code || e.message}`;
    }
  }

  // prerender-manifest: is "/" prerendered?
  let prerender = {};
  for (const p of [
    path.join(cwd, ".next/prerender-manifest.json"),
    path.join(cwd, ".next/standalone/.next/prerender-manifest.json"),
  ]) {
    try {
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      prerender[p] = { rootPrerendered: Object.keys(m.routes || {}).includes("/") };
    } catch (e) {
      prerender[p] = `ENOENT/${e.code || e.message}`;
    }
  }

  // Decisive: self-fetch / from inside the container (bypasses Traefik/edge).
  let selfFetch = {};
  try {
    const r = await fetch("http://127.0.0.1:20128/", { redirect: "manual" });
    selfFetch = {
      status: r.status,
      location: r.headers.get("location"),
      xNextjsPrerender: r.headers.get("x-nextjs-prerender"),
      xNextjsCache: r.headers.get("x-nextjs-cache"),
      cacheControl: r.headers.get("cache-control"),
    };
  } catch (e) {
    selfFetch = { error: e.message };
  }

  return NextResponse.json(
    { nextVersion, cwd, fsInfo, appPaths, prerender, selfFetch },
    { headers: { "cache-control": "no-store" } },
  );
}
