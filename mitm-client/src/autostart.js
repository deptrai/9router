// AC5 — Auto-start on boot.
// macOS: launchd plist (~/Library/LaunchAgents/com.9r.mitm-client.plist)
// Linux: systemd user service (~/.config/systemd/user/9r-mitm-client.service)
// Windows: Task Scheduler ("9R MITM Client")
// On boot: MITM server starts + DNS entries restored from config.enabledTools.
// Node path detected at creation time via process.execPath (NOT hardcoded).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { log, err } = require("./logger");
const { loadConfig, saveConfig } = require("./config");

const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";
const IS_WIN = process.platform === "win32";

const LABEL = "com.9r.mitm-client";
const WIN_TASK_NAME = "9R MITM Client";

// ── Path helpers ──────────────────────────────────────────────

function getLaunchdPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function getSystemdServicePath() {
  return path.join(os.homedir(), ".config", "systemd", "user", "9r-mitm-client.service");
}

function getAutostartPath() {
  if (IS_MAC) return getLaunchdPlistPath();
  if (IS_LINUX) return getSystemdServicePath();
  if (IS_WIN) return null; // Windows uses Task Scheduler, no file path.
  return null;
}

// ── Detect node + mitm-client binary path at runtime ──────────

function getBinPath() {
  // When installed globally via npm, bin is symlinked.
  // Use process.argv[1] (the script being executed) as the entry point.
  const scriptPath = process.argv[1] || path.join(__dirname, "..", "bin", "mitm-client.js");
  return scriptPath;
}

function getNodePath() {
  // Use process.execPath — the actual node binary path at runtime.
  return process.execPath;
}

// ── macOS launchd plist generation ────────────────────────────

function generateLaunchdPlist() {
  const nodePath = getNodePath();
  const binPath = getBinPath();
  const dataDir = path.join(os.homedir(), ".9r-mitm-client");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${binPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${dataDir}/logs/autostart.log</string>
  <key>StandardErrorPath</key>
  <string>${dataDir}/logs/autostart-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
  return plist;
}

// ── Linux systemd user service generation ─────────────────────

function generateSystemdService() {
  const nodePath = getNodePath();
  const binPath = getBinPath();

  const service = `[Unit]
Description=9R MITM Client
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${binPath} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  return service;
}

// ── Enable autostart ──────────────────────────────────────────

function autostartOn() {
  if (IS_MAC) {
    const plistPath = getLaunchdPlistPath();
    const plistDir = path.dirname(plistPath);
    if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true });
    const plist = generateLaunchdPlist();
    fs.writeFileSync(plistPath, plist, "utf8");
    log(`✅ Autostart enabled (macOS launchd): ${plistPath}`);
    log(`   Node path: ${getNodePath()}`);
    log(`   Bin path:  ${getBinPath()}`);
    // Load the agent.
    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" });
    } catch { /* may already be loaded */ }
    saveConfig({ autostart: true });
    return { ok: true, path: plistPath };
  }

  if (IS_LINUX) {
    const servicePath = getSystemdServicePath();
    const serviceDir = path.dirname(servicePath);
    if (!fs.existsSync(serviceDir)) fs.mkdirSync(serviceDir, { recursive: true });
    const service = generateSystemdService();
    fs.writeFileSync(servicePath, service, "utf8");
    log(`✅ Autostart enabled (Linux systemd): ${servicePath}`);
    log(`   Node path: ${getNodePath()}`);
    log(`   Bin path:  ${getBinPath()}`);
    try {
      execSync("systemctl --user daemon-reload", { stdio: "ignore" });
      execSync("systemctl --user enable 9r-mitm-client", { stdio: "ignore" });
    } catch { /* best effort */ }
    saveConfig({ autostart: true });
    return { ok: true, path: servicePath };
  }

  if (IS_WIN) {
    const nodePath = getNodePath();
    const binPath = getBinPath();
    try {
      execSync(
        `schtasks /create /tn "${WIN_TASK_NAME}" /tr "${nodePath} ${binPath} start" /sc onlogon /rl highest /f`,
        { stdio: "inherit" }
      );
      log(`✅ Autostart enabled (Windows Task Scheduler): ${WIN_TASK_NAME}`);
      saveConfig({ autostart: true });
      return { ok: true };
    } catch (e) {
      err(`Failed to create Windows scheduled task: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  err(`Unsupported platform: ${process.platform}`);
  return { ok: false, error: "Unsupported platform" };
}

// ── Disable autostart ─────────────────────────────────────────

function autostartOff() {
  if (IS_MAC) {
    const plistPath = getLaunchdPlistPath();
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }); } catch {}
    try { fs.unlinkSync(plistPath); } catch {}
    log("⏹ Autostart disabled (macOS launchd)");
    saveConfig({ autostart: false });
    return { ok: true };
  }

  if (IS_LINUX) {
    const servicePath = getSystemdServicePath();
    try {
      execSync("systemctl --user disable 9r-mitm-client", { stdio: "ignore" });
    } catch {}
    try { fs.unlinkSync(servicePath); } catch {}
    try { execSync("systemctl --user daemon-reload", { stdio: "ignore" }); } catch {}
    log("⏹ Autostart disabled (Linux systemd)");
    saveConfig({ autostart: false });
    return { ok: true };
  }

  if (IS_WIN) {
    try {
      execSync(`schtasks /delete /tn "${WIN_TASK_NAME}" /f`, { stdio: "inherit" });
      log("⏹ Autostart disabled (Windows Task Scheduler)");
      saveConfig({ autostart: false });
      return { ok: true };
    } catch (e) {
      err(`Failed to delete Windows scheduled task: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  err(`Unsupported platform: ${process.platform}`);
  return { ok: false, error: "Unsupported platform" };
}

// ── Status ────────────────────────────────────────────────────

function autostartStatus() {
  if (IS_MAC) {
    const plistPath = getLaunchdPlistPath();
    const exists = fs.existsSync(plistPath);
    if (exists) {
      // Read plist to show node path (verify not hardcoded).
      let nodePath = null;
      try {
        const content = fs.readFileSync(plistPath, "utf8");
        const match = content.match(/<string>([^<]+node[^<]*)<\/string>/);
        if (match) nodePath = match[1];
      } catch {}
      return { enabled: true, platform: "macOS launchd", path: plistPath, nodePath };
    }
    return { enabled: false, platform: "macOS launchd", path: plistPath };
  }

  if (IS_LINUX) {
    const servicePath = getSystemdServicePath();
    const exists = fs.existsSync(servicePath);
    return { enabled: exists, platform: "Linux systemd", path: servicePath };
  }

  if (IS_WIN) {
    try {
      execSync(`schtasks /query /tn "${WIN_TASK_NAME}"`, { stdio: "ignore" });
      return { enabled: true, platform: "Windows Task Scheduler", taskName: WIN_TASK_NAME };
    } catch {
      return { enabled: false, platform: "Windows Task Scheduler", taskName: WIN_TASK_NAME };
    }
  }

  return { enabled: false, platform: process.platform, error: "Unsupported platform" };
}

module.exports = {
  autostartOn, autostartOff, autostartStatus,
  generateLaunchdPlist, generateSystemdService,
  getLaunchdPlistPath, getSystemdServicePath, getAutostartPath,
  getNodePath, getBinPath, LABEL, WIN_TASK_NAME,
};
