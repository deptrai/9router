/**
 * Story 3.1 — Multi-machine distribution unit tests.
 *
 * Test các logic thuần (pure logic) có thể import mà không trigger module-level
 * side effects crash:
 * - AC2: devinDetect.js (path scanning, TOML parser)
 * - AC3: devinLink.js (TOML serialize, atomic write)
 * - AC5: autostart.js (plist/service generation, node path detection)
 * - AC6: profiles.js (add/list/use/remove, validation)
 * - AC9: sync-protobuf.sh (integration — verify output files are valid CJS)
 *
 * AC1 (spike) cần manual test (MITM server + Devin CLI + DNS redirect).
 * AC4 (npm pack) cần manual test (npm pack + npm i -g).
 * AC7 (wizard) cần integration test (interactive flow).
 * AC8 (uninstall) cần integration test (sudo + keychain + /etc/hosts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import os from "os";

const require = createRequire(import.meta.url);

// ── AC2: devinDetect.js ───────────────────────────────────────

describe("AC2 — devinDetect", () => {
  const { parseSimpleToml, SCAN_PATHS } = require("../../mitm-client/src/devinDetect.js");

  describe("parseSimpleToml", () => {
    it("parse string values", () => {
      const result = parseSimpleToml('api_server_url = "https://server.codeium.com"');
      expect(result.api_server_url).toBe("https://server.codeium.com");
    });

    it("parse single-quoted strings", () => {
      const result = parseSimpleToml("api_key = 'secret123'");
      expect(result.api_key).toBe("secret123");
    });

    it("parse boolean values", () => {
      const result = parseSimpleToml("enabled = true\ndisabled = false");
      expect(result.enabled).toBe(true);
      expect(result.disabled).toBe(false);
    });

    it("parse integer values", () => {
      const result = parseSimpleToml("port = 8080");
      expect(result.port).toBe(8080);
    });

    it("parse float values", () => {
      const result = parseSimpleToml("timeout = 3.14");
      expect(result.timeout).toBe(3.14);
    });

    it("skip comments and blank lines", () => {
      const toml = "# This is a comment\n\nkey = \"value\"  # inline comment\n";
      const result = parseSimpleToml(toml);
      expect(result.key).toBe("value");
      expect(Object.keys(result)).toHaveLength(1);
    });

    it("parse real Devin credentials.toml format", () => {
      const toml = `windsurf_api_key = "devin-session-token$abc123"
api_server_url = "https://server.codeium.com"
devin_webapp_host = "app.devin.ai"
devin_api_url = "https://api.devin.ai"`;
      const result = parseSimpleToml(toml);
      expect(result.windsurf_api_key).toBe("devin-session-token$abc123");
      expect(result.api_server_url).toBe("https://server.codeium.com");
      expect(result.devin_webapp_host).toBe("app.devin.ai");
      expect(result.devin_api_url).toBe("https://api.devin.ai");
    });
  });

  describe("SCAN_PATHS", () => {
    it("có paths cho darwin (macOS)", () => {
      expect(SCAN_PATHS.darwin).toBeDefined();
      expect(SCAN_PATHS.darwin.length).toBeGreaterThan(0);
    });

    it("có paths cho linux", () => {
      expect(SCAN_PATHS.linux).toBeDefined();
      expect(SCAN_PATHS.linux.length).toBeGreaterThan(0);
    });

    it("có paths cho win32 (Windows)", () => {
      expect(SCAN_PATHS.win32).toBeDefined();
      expect(SCAN_PATHS.win32.length).toBeGreaterThan(0);
    });
  });
});

// ── AC3: devinLink.js ─────────────────────────────────────────

describe("AC3 — devinLink", () => {
  const { serializeSimpleToml, atomicWriteFile, TARGET_API_SERVER_URL } = require("../../mitm-client/src/devinLink.js");

  describe("serializeSimpleToml", () => {
    it("serialize string values", () => {
      const result = serializeSimpleToml({ key: "value" });
      expect(result).toBe('key = "value"\n');
    });

    it("serialize boolean values", () => {
      const result = serializeSimpleToml({ enabled: true, disabled: false });
      expect(result).toContain("enabled = true");
      expect(result).toContain("disabled = false");
    });

    it("serialize number values", () => {
      const result = serializeSimpleToml({ port: 8080, timeout: 3.14 });
      expect(result).toContain("port = 8080");
      expect(result).toContain("timeout = 3.14");
    });

    it("round-trip: parse → serialize → parse", () => {
      const { parseSimpleToml } = require("../../mitm-client/src/devinDetect.js");
      const original = { api_server_url: "https://server.codeium.com", port: 443, enabled: true };
      const serialized = serializeSimpleToml(original);
      const parsed = parseSimpleToml(serialized);
      expect(parsed).toEqual(original);
    });
  });

  describe("atomicWriteFile", () => {
    const tmpDir = path.join(os.tmpdir(), `9r-test-${Date.now()}`);
    beforeEach(() => { fs.mkdirSync(tmpDir, { recursive: true }); });
    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it("write file atomically (temp + rename)", () => {
      const target = path.join(tmpDir, "test.toml");
      atomicWriteFile(target, "key = \"value\"\n");
      expect(fs.readFileSync(target, "utf8")).toBe("key = \"value\"\n");
      // Temp file should not exist after write.
      expect(fs.existsSync(`${target}.9r-tmp`)).toBe(false);
    });
  });

  describe("TARGET_API_SERVER_URL", () => {
    it("targets server.codeium.com", () => {
      expect(TARGET_API_SERVER_URL).toBe("https://server.codeium.com");
    });
  });
});

// ── AC5: autostart.js ─────────────────────────────────────────

describe("AC5 — autostart", () => {
  const { generateLaunchdPlist, generateSystemdService, getNodePath, getBinPath, LABEL } = require("../../mitm-client/src/autostart.js");

  describe("generateLaunchdPlist", () => {
    it("generates valid XML plist", () => {
      const plist = generateLaunchdPlist();
      expect(plist).toContain("<?xml version=\"1.0\"");
      expect(plist).toContain("<plist version=\"1.0\">");
      expect(plist).toContain("</plist>");
    });

    it("contains correct Label", () => {
      const plist = generateLaunchdPlist();
      expect(plist).toContain(`<key>Label</key>`);
      expect(plist).toContain(`<string>${LABEL}</string>`);
    });

    it("uses process.execPath (NOT hardcoded /usr/local/bin/node)", () => {
      const plist = generateLaunchdPlist();
      const nodePath = process.execPath;
      expect(plist).toContain(nodePath);
      // Should NOT contain hardcoded path (unless execPath happens to be that).
      if (nodePath !== "/usr/local/bin/node") {
        expect(plist).not.toContain("/usr/local/bin/node");
      }
    });

    it("contains RunAtLoad true", () => {
      const plist = generateLaunchdPlist();
      expect(plist).toContain("<key>RunAtLoad</key>");
      expect(plist).toContain("<true/>");
    });

    it("contains 'start' as program argument", () => {
      const plist = generateLaunchdPlist();
      expect(plist).toContain("<string>start</string>");
    });
  });

  describe("generateSystemdService", () => {
    it("generates valid systemd unit", () => {
      const service = generateSystemdService();
      expect(service).toContain("[Unit]");
      expect(service).toContain("[Service]");
      expect(service).toContain("[Install]");
      expect(service).toContain("Description=9R MITM Client");
    });

    it("contains After=network.target", () => {
      const service = generateSystemdService();
      expect(service).toContain("After=network.target");
    });

    it("uses process.execPath in ExecStart", () => {
      const service = generateSystemdService();
      expect(service).toContain(process.execPath);
    });
  });

  describe("getNodePath / getBinPath", () => {
    it("getNodePath returns process.execPath", () => {
      expect(getNodePath()).toBe(process.execPath);
    });

    it("getBinPath returns a string path", () => {
      const binPath = getBinPath();
      expect(typeof binPath).toBe("string");
      expect(binPath.length).toBeGreaterThan(0);
    });
  });
});

// ── AC6: profiles.js ──────────────────────────────────────────

describe("AC6 — profiles", () => {
  // Use temp DATA_DIR via env to avoid touching real config.
  let tmpDir;
  let originalDataDir;
  let mod;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `9r-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    // Clear module cache so paths.js picks up new DATA_DIR.
    delete require.cache[require.resolve("../../mitm-client/src/paths.js")];
    delete require.cache[require.resolve("../../mitm-client/src/profiles.js")];
    delete require.cache[require.resolve("../../mitm-client/src/config.js")];
    delete require.cache[require.resolve("../../mitm-client/src/logger.js")];
    // Re-require with new DATA_DIR.
    mod = require("../../mitm-client/src/profiles.js");
  });

  afterEach(() => {
    process.env.DATA_DIR = originalDataDir;
    // Clear cache again so other tests get original DATA_DIR.
    delete require.cache[require.resolve("../../mitm-client/src/paths.js")];
    delete require.cache[require.resolve("../../mitm-client/src/profiles.js")];
    delete require.cache[require.resolve("../../mitm-client/src/config.js")];
    delete require.cache[require.resolve("../../mitm-client/src/logger.js")];
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("default profile 'local' exists", () => {
    const profiles = mod.loadProfiles();
    expect(profiles.local).toBeDefined();
    expect(profiles.local.routerUrl).toBe("http://localhost:20128");
  });

  it("addProfile saves a new profile", () => {
    const result = mod.addProfile("prod", "http://prod:20128", "key1", "Production");
    expect(result.ok).toBe(true);
    const profiles = mod.loadProfiles();
    expect(profiles.prod).toBeDefined();
    expect(profiles.prod.routerUrl).toBe("http://prod:20128");
    expect(profiles.prod.apiKey).toBe("key1");
  });

  it("addProfile rejects invalid URL", () => {
    const result = mod.addProfile("bad", "not-a-url", "key");
    expect(result.ok).toBe(false);
  });

  it("addProfile rejects empty name", () => {
    const result = mod.addProfile("", "http://prod:20128", "key");
    expect(result.ok).toBe(false);
  });

  it("listProfiles shows all profiles", () => {
    mod.addProfile("prod", "http://prod:20128", "key1");
    const result = mod.listProfiles();
    expect(result.profiles.length).toBeGreaterThanOrEqual(2); // local + prod
    const names = result.profiles.map(p => p.name);
    expect(names).toContain("local");
    expect(names).toContain("prod");
  });

  it("useProfile switches active config", () => {
    mod.addProfile("prod", "http://prod:20128", "key1");
    const result = mod.useProfile("prod");
    expect(result.ok).toBe(true);
    // Verify config was updated (re-require config with same cache).
    const { loadConfig } = require("../../mitm-client/src/config.js");
    const cfg = loadConfig();
    expect(cfg.routerUrl).toBe("http://prod:20128");
    expect(cfg.apiKey).toBe("key1");
  });

  it("useProfile rejects unknown profile", () => {
    const result = mod.useProfile("nonexistent");
    expect(result.ok).toBe(false);
  });

  it("removeProfile deletes a profile", () => {
    mod.addProfile("temp", "http://temp:20128", "key");
    const result = mod.removeProfile("temp");
    expect(result.ok).toBe(true);
    const profiles = mod.loadProfiles();
    expect(profiles.temp).toBeUndefined();
  });

  it("removeProfile refuses to remove 'local'", () => {
    const result = mod.removeProfile("local");
    expect(result.ok).toBe(false);
  });

  it("profiles.json has mode 0o600", () => {
    mod.addProfile("prod", "http://prod:20128", "key1");
    const profilesFile = path.join(tmpDir, "profiles.json");
    const stat = fs.statSync(profilesFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ── AC9: sync-protobuf.sh (integration) ───────────────────────

describe("AC9 — sync-protobuf.sh output verification", () => {
  const utilsDir = path.join(__dirname, "..", "..", "mitm-client", "src", "utils");

  it("windsurfProtobuf.js exists and is valid CJS", () => {
    const filePath = path.join(utilsDir, "windsurfProtobuf.js");
    expect(fs.existsSync(filePath)).toBe(true);
    // Should be requireable (valid CJS).
    expect(() => require(filePath)).not.toThrow();
  });

  it("windsurfAuth.js exists and is valid CJS", () => {
    const filePath = path.join(utilsDir, "windsurfAuth.js");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(() => require(filePath)).not.toThrow();
  });

  it("windsurfProtobuf.js exports expected functions", () => {
    const mod = require(path.join(utilsDir, "windsurfProtobuf.js"));
    expect(mod.encodeVarint).toBeDefined();
    expect(mod.decodeVarint).toBeDefined();
    expect(mod.buildGetChatMessageRequest).toBeDefined();
    expect(mod.decodeGetChatMessageResponse).toBeDefined();
  });

  it("windsurfAuth.js exports expected functions", () => {
    const mod = require(path.join(utilsDir, "windsurfAuth.js"));
    expect(mod.buildMetadata).toBeDefined();
    expect(mod.buildAuthHeader).toBeDefined();
  });

  it("files contain no ESM import/export statements", () => {
    const protoContent = fs.readFileSync(path.join(utilsDir, "windsurfProtobuf.js"), "utf8");
    const authContent = fs.readFileSync(path.join(utilsDir, "windsurfAuth.js"), "utf8");
    // Should not have ESM import/export at line start.
    expect(protoContent).not.toMatch(/^import\s/m);
    expect(protoContent).not.toMatch(/^export\s+function/m);
    expect(protoContent).not.toMatch(/^export\s+const/m);
    expect(authContent).not.toMatch(/^import\s/m);
    expect(authContent).not.toMatch(/^export\s+function/m);
    expect(authContent).not.toMatch(/^export\s+const/m);
  });

  it("files contain module.exports", () => {
    const protoContent = fs.readFileSync(path.join(utilsDir, "windsurfProtobuf.js"), "utf8");
    const authContent = fs.readFileSync(path.join(utilsDir, "windsurfAuth.js"), "utf8");
    expect(protoContent).toContain("module.exports");
    expect(authContent).toContain("module.exports");
  });
});
