#!/usr/bin/env node
// 9R MITM Client — standalone CLI entry point.
// Usage: mitm-client <command> [args]
// Commands: setup, start, stop, status, dns-on, dns-off, dns-off-all, tui, config, logs,
//           detect-devin, link-devin, unlink-devin, profile, autostart, wizard, uninstall
const { loadConfig, saveConfig } = require("../src/config");
const { generateRootCA, ROOT_CA_CERT_PATH } = require("../src/cert/rootCA");
const { trustCert, untrustCert } = require("../src/cert/install");
const { addDNSEntry, removeDNSEntry, removeAllDNSEntries, checkAllDNSStatus } = require("../src/dns/dnsConfig");
const { TOOL_HOSTS } = require("../src/mitmConfig");
const { log, err } = require("../src/logger");
const { readSudoPassword } = require("../src/ui/password");
const fs = require("fs");
const path = require("path");
const { CONFIG_FILE, DATA_DIR, MITM_DIR } = require("../src/paths");

// Read version from package.json.
const PKG = require("../package.json");
const VERSION = PKG.version;

const args = process.argv.slice(2);
const cmd = args[0];

function printHelp() {
  console.log(`
9R MITM Client — standalone MITM for 9router (v${VERSION})

Commands:
  setup                          Generate Root CA + trust in system keychain
  start                          Start MITM server on :443 (needs root/sudo)
  stop                           Stop running MITM server
  status                         Show MITM server + DNS status
  dns-on <tool>                  Enable DNS redirect for tool (windsurf|antigravity|copilot|kiro|cursor)
  dns-off <tool>                 Disable DNS redirect for tool
  dns-off-all                    Disable all DNS redirects
  config <key> [value]           Get/set config (routerUrl, apiKey, mitmDebug, windsurfAlias)
  config --list                  Show full config
  tui                            Interactive terminal UI (start/stop/dns/logs)
  logs [tail]                    Show recent MITM logs (or tail -f)
  detect-devin                   Auto-detect Devin CLI installation
  link-devin                     Link Devin CLI to MITM (backup + modify credentials.toml)
  unlink-devin                   Restore Devin CLI credentials from backup
  profile add <name> <url> <key> Save a config profile
  profile list                   List all config profiles
  profile use <name>             Switch active config profile
  profile remove <name>          Remove a config profile
  autostart on                   Enable auto-start on boot (launchd/systemd/Task Scheduler)
  autostart off                  Disable auto-start on boot
  autostart status               Show auto-start status
  wizard                         Interactive setup wizard (CA + config + start + DNS)
  uninstall                      Untrust CA + remove DNS + delete data dir
  --version                      Show version
  help                           Show this help

Config file: ${CONFIG_FILE}
Data dir:    ${DATA_DIR}

Examples:
  mitm-client config routerUrl https://9router.example.com
  mitm-client config apiKey sk-xxxx
  mitm-client setup
  sudo mitm-client start
  mitm-client dns-on windsurf
  mitm-client wizard
  mitm-client profile add prod http://prod:20128 key1
`);
}

// AC5 — readSudoPassword now imported from src/ui/password.js
// (supports non-TTY fallback: env SUDO_PASSWORD, file ~/.sudo-password).

async function main() {
  switch (cmd) {
    case "setup": {
      log("🔐 Generating Root CA...");
      await generateRootCA();
      log(`Root CA: ${ROOT_CA_CERT_PATH}`);
      const ok = trustCert();
      if (ok) saveConfig({ certTrusted: true });
      log("✅ Setup complete. Now: mitm-client config routerUrl <url> + config apiKey <key>, then: sudo mitm-client start");
      break;
    }
    case "start": {
      const { start } = require("../src/server");
      start();
      break;
    }
    case "stop": {
      try {
        const out = require("child_process").execSync("lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }).trim();
        if (out) {
          out.split("\n").forEach(pid => { try { process.kill(Number(pid), "SIGTERM"); } catch {} });
          log("⏹ MITM server stopped");
        } else { log("MITM server not running"); }
      } catch { log("MITM server not running"); }
      break;
    }
    case "status": {
      let running = false, pid = null;
      try {
        const out = require("child_process").execSync("lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }).trim();
        if (out) { running = true; pid = out.split("\n")[0]; }
      } catch {}
      const dns = checkAllDNSStatus();
      const cfg = loadConfig();
      const certExists = fs.existsSync(ROOT_CA_CERT_PATH);
      console.log(JSON.stringify({ running, pid, certExists, certTrusted: cfg.certTrusted, routerUrl: cfg.routerUrl, apiKeySet: !!cfg.apiKey, dns, enabledTools: cfg.enabledTools }, null, 2));
      break;
    }
    case "dns-on": {
      const tool = args[1];
      if (!tool || !TOOL_HOSTS[tool]) { err(`Usage: dns-on <tool> (one of: ${Object.keys(TOOL_HOSTS).join(", ")})`); process.exit(1); }
      const pwd = await readSudoPassword();
      await addDNSEntry(tool, pwd);
      const cfg = loadConfig();
      if (!cfg.enabledTools.includes(tool)) {
        cfg.enabledTools.push(tool);
        saveConfig({ enabledTools: cfg.enabledTools });
      }
      break;
    }
    case "dns-off": {
      const tool = args[1];
      if (!tool || !TOOL_HOSTS[tool]) { err(`Usage: dns-off <tool>`); process.exit(1); }
      const pwd = await readSudoPassword();
      await removeDNSEntry(tool, pwd);
      const cfg = loadConfig();
      cfg.enabledTools = cfg.enabledTools.filter(t => t !== tool);
      saveConfig({ enabledTools: cfg.enabledTools });
      break;
    }
    case "dns-off-all": {
      const pwd = await readSudoPassword();
      await removeAllDNSEntries(pwd);
      saveConfig({ enabledTools: [] });
      break;
    }
    case "config": {
      const key = args[1];
      if (!key || key === "--list") {
        console.log(JSON.stringify(loadConfig(), null, 2));
        break;
      }
      const value = args[2];
      if (value === undefined) {
        console.log(loadConfig()[key]);
      } else {
        // coerce types
        let coerced = value;
        if (value === "true") coerced = true;
        else if (value === "false") coerced = false;
        saveConfig({ [key]: coerced });
        log(`config ${key} = ${coerced}`);
      }
      break;
    }
    case "tui": {
      const { runTui } = require("../src/ui/cli");
      await runTui();
      break;
    }
    case "logs": {
      const { DATA_DIR } = require("../src/paths");
      const logDir = require("path").join(DATA_DIR, "logs", "mitm");
      if (!fs.existsSync(logDir)) { log("No logs yet"); break; }
      if (args[1] === "tail") {
        const { spawn } = require("child_process");
        spawn("tail", ["-f", logDir], { stdio: "inherit" });
      } else {
        const files = fs.readdirSync(logDir).sort().slice(-10);
        for (const f of files) {
          console.log(`\n=== ${f} ===`);
          console.log(fs.readFileSync(require("path").join(logDir, f), "utf8").slice(0, 2000));
        }
      }
      break;
    }
    case "detect-devin": {
      const { detectDevin } = require("../src/devinDetect");
      const result = detectDevin();
      if (result.found) {
        log("✅ Devin CLI detected:");
        console.log(`  Install dir:       ${result.installDir}`);
        console.log(`  Credentials:       ${result.credentialsPath || "(not found)"}`);
        console.log(`  API server URL:    ${result.apiServerUrl || "(not set)"}`);
        console.log(`  API key:           ${result.apiKey || "(not set)"}`);
      } else {
        log("❌ Devin CLI not found.");
        console.log(`  ${result.message}`);
        console.log("  Searched paths:");
        const { SCAN_PATHS } = require("../src/devinDetect");
        for (const p of (SCAN_PATHS[process.platform] || [])) {
          console.log(`    • ${p}`);
        }
      }
      break;
    }
    case "link-devin": {
      const { linkDevin } = require("../src/devinLink");
      const result = linkDevin();
      if (!result.ok) process.exit(1);
      break;
    }
    case "unlink-devin": {
      const { unlinkDevin } = require("../src/devinLink");
      const result = unlinkDevin();
      if (!result.ok) process.exit(1);
      break;
    }
    case "profile": {
      const profiles = require("../src/profiles");
      const subCmd = args[1];
      if (subCmd === "add") {
        const name = args[2];
        const url = args[3];
        const key = args[4];
        const desc = args[5];
        const result = profiles.addProfile(name, url, key, desc);
        if (!result.ok) process.exit(1);
      } else if (subCmd === "list") {
        const result = profiles.listProfiles();
        console.log("Profiles:");
        for (const p of result.profiles) {
          const marker = p.active ? " ← active" : "";
          console.log(`  ${p.name.padEnd(12)} ${p.routerUrl.padEnd(40)} key: ${p.apiKey}${p.description ? "  (" + p.description + ")" : ""}${marker}`);
        }
        if (result.activeProfile) console.log(`\nActive: ${result.activeProfile}`);
      } else if (subCmd === "use") {
        const name = args[2];
        if (!name) { err("Usage: profile use <name>"); process.exit(1); }
        const result = profiles.useProfile(name);
        if (!result.ok) process.exit(1);
      } else if (subCmd === "remove" || subCmd === "rm") {
        const name = args[2];
        if (!name) { err("Usage: profile remove <name>"); process.exit(1); }
        const result = profiles.removeProfile(name);
        if (!result.ok) process.exit(1);
      } else {
        err("Usage: profile <add|list|use|remove> [args]");
        process.exit(1);
      }
      break;
    }
    case "autostart": {
      const autostart = require("../src/autostart");
      const subCmd = args[1];
      if (subCmd === "on") {
        const result = autostart.autostartOn();
        if (!result.ok) process.exit(1);
      } else if (subCmd === "off") {
        const result = autostart.autostartOff();
        if (!result.ok) process.exit(1);
      } else if (subCmd === "status") {
        const result = autostart.autostartStatus();
        console.log(JSON.stringify(result, null, 2));
      } else {
        err("Usage: autostart <on|off|status>");
        process.exit(1);
      }
      break;
    }
    case "wizard": {
      const { runWizard } = require("../src/wizard");
      await runWizard();
      break;
    }
    case "uninstall": {
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const confirm = await new Promise((resolve) => {
        rl.question("⚠️  This will remove CA trust, DNS entries, and delete ~/.9r-mitm-client/. Continue? (y/N): ", (answer) => resolve(answer.trim().toLowerCase()));
      });
      rl.close();
      if (confirm !== "y" && confirm !== "yes") {
        log("Uninstall cancelled.");
        break;
      }
      // 1. Untrust CA.
      log("🔐 Removing CA trust...");
      untrustCert();
      // 2. Remove all DNS entries.
      log("🌐 Removing all DNS entries...");
      const pwd = await readSudoPassword();
      try { await removeAllDNSEntries(pwd); } catch (e) { err(`DNS removal failed: ${e.message}`); }
      saveConfig({ enabledTools: [] });
      // 3. Delete data dir.
      log("🗑 Deleting data directory...");
      try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
        log(`✅ Removed: ${DATA_DIR}`);
      } catch (e) { err(`Failed to delete data dir: ${e.message}`); }
      log("✅ Uninstall complete.");
      break;
    }
    case "--version":
    case "-v":
      console.log(`9r-mitm-client v${VERSION}`);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      err(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

// P17: log full stack trace for debugging, not just message.
main().catch((e) => { err(e.stack || e.message); process.exit(1); });
