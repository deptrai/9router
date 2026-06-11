import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve("/Users/luisphan/Documents/9router");

const handlerFiles = [
  "src/sse/handlers/chat.js",
  "src/sse/handlers/search.js",
  "src/sse/handlers/fetch.js",
  "src/sse/handlers/embeddings.js",
  "src/sse/handlers/imageGeneration.js",
  "src/sse/handlers/tts.js",
  "src/sse/handlers/stt.js",
];

describe("fallback source guards", () => {
  it("all SSE all-locked branches normalize stale upstream status codes", () => {
    for (const relativePath of handlerFiles) {
      const content = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

      expect(content, `${relativePath} imports normalizeUnavailableStatus`).toContain("normalizeUnavailableStatus");
      expect(content, `${relativePath} normalizes lastErrorCode before unavailableResponse`).toContain(
        "normalizeUnavailableStatus(lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE)"
      );
    }
  });
});
