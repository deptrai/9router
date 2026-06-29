// AC2 — Auto-detect Devin CLI installation.
// Scans common paths per-platform, parses credentials.toml (inline TOML parser, no dep).
// Reports: found path, current api_server_url, credentials.toml location.

const fs = require("fs");
const path = require("path");
const os = require("os");

// Common Devin CLI install paths per platform.
const SCAN_PATHS = {
  darwin: [
    path.join(os.homedir(), ".local/share/devin"),
    path.join(os.homedir(), "Library/Application Support/devin"),
  ],
  linux: [
    path.join(os.homedir(), ".local/share/devin"),
    path.join(os.homedir(), ".config/devin"),
  ],
  win32: [
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "devin"),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "devin"),
  ],
};

// ── Inline TOML parser (simple key=value, no nested tables) ─────
// Handles: key = "value", key = true, key = false, key = 123
// Comments (#) and blank lines are skipped.

function parseSimpleToml(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    // Strip trailing comment.
    const commentIdx = value.indexOf(" #");
    if (commentIdx !== -1) value = value.substring(0, commentIdx).trim();
    // String value.
    if (value.startsWith('"') && value.endsWith('"')) {
      result[key] = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      result[key] = value.slice(1, -1);
    } else if (value === "true") {
      result[key] = true;
    } else if (value === "false") {
      result[key] = false;
    } else if (/^-?\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
    } else if (/^-?\d+\.\d+$/.test(value)) {
      result[key] = parseFloat(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Detect Devin CLI ───────────────────────────────────────────

function findDevinInstall() {
  const paths = SCAN_PATHS[process.platform] || SCAN_PATHS.linux;
  for (const dir of paths) {
    if (fs.existsSync(dir)) {
      // Check for credentials.toml or CLI binary.
      const credPath = path.join(dir, "credentials.toml");
      const cliDir = path.join(dir, "cli");
      const hasCred = fs.existsSync(credPath);
      const hasCli = fs.existsSync(cliDir);
      if (hasCred || hasCli) {
        return { installDir: dir, credentialsPath: hasCred ? credPath : null };
      }
    }
  }
  // Fallback: search for devin binary in PATH.
  try {
    const { execSync } = require("child_process");
    const binPath = execSync("which devin 2>/dev/null || where devin 2>nul", { encoding: "utf8" }).trim().split("\n")[0];
    if (binPath && fs.existsSync(binPath)) {
      // Resolve symlink to find install dir.
      let realPath = binPath;
      try { realPath = fs.realpathSync(binPath); } catch {}
      // Install dir is typically 3-4 levels up from the binary.
      const parts = realPath.split(path.sep);
      const devinIdx = parts.lastIndexOf("devin");
      if (devinIdx !== -1) {
        const installDir = parts.slice(0, devinIdx + 1).join(path.sep);
        const credPath = path.join(installDir, "credentials.toml");
        return { installDir, credentialsPath: fs.existsSync(credPath) ? credPath : null };
      }
    }
  } catch { /* devin not in PATH */ }
  return null;
}

function detectDevin() {
  const install = findDevinInstall();
  if (!install) {
    return {
      found: false,
      message: "Devin CLI not found. Enter path manually or install Devin CLI first.",
      installDir: null,
      credentialsPath: null,
      apiServerUrl: null,
      apiKey: null,
    };
  }

  let apiServerUrl = null;
  let apiKey = null;
  let credentials = null;

  if (install.credentialsPath) {
    try {
      const content = fs.readFileSync(install.credentialsPath, "utf8");
      credentials = parseSimpleToml(content);
      apiServerUrl = credentials.api_server_url || null;
      apiKey = credentials.windsurf_api_key || credentials.api_key || null;
    } catch { /* read error */ }
  }

  return {
    found: true,
    installDir: install.installDir,
    credentialsPath: install.credentialsPath,
    apiServerUrl,
    apiKey: apiKey ? `${apiKey.substring(0, 12)}...` : null, // mask for display
    credentials,
  };
}

module.exports = { detectDevin, findDevinInstall, parseSimpleToml, SCAN_PATHS };
