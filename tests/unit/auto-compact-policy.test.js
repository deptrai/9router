import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Kiro auto-compact policy wiring", () => {
  it("defaults Kiro auto-compact on and passes the setting into chatCore", () => {
    const root = process.cwd();
    const settingsRepo = fs.readFileSync(path.join(root, "src/lib/db/repos/settingsRepo.js"), "utf8");
    const chatHandler = fs.readFileSync(path.join(root, "src/sse/handlers/chat.js"), "utf8");
    const chatCore = fs.readFileSync(path.join(root, "open-sse/handlers/chatCore.js"), "utf8");

    expect(settingsRepo).toContain("kiroAutoCompactEnabled: true");
    expect(chatHandler).toContain("kiroAutoCompactEnabled: !!chatSettings.kiroAutoCompactEnabled");
    expect(chatCore).toContain("kiroAutoCompactEnabled");
    expect(chatCore).toContain("options: { enabled: !!kiroAutoCompactEnabled }");
    expect(chatCore).toContain("AUTO_COMPACT_DISABLED");
  });
});
