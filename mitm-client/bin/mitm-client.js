#!/usr/bin/env node
// 9R MITM Client — standalone CLI entry point.
// Usage: mitm-client <command> [args]
// Commands: setup, start, stop, status, dns-on <tool>, dns-off <tool>, dns-off-all, tui, config, logs
const { loadConfig, saveConfig } = require("../src/config");
const { generateRootCA, ROOT_CA_CERT_PATH } = require("../src/cert/rootCA");
const { trustCert, untrustCert } = require("../src/cert/install");
const { addDNSEntry, removeDNSEntry, removeAllDNSEntries, checkAllDNSStatus, isSudoPasswordRequired } = require("../src/dns/dnsConfig");
const { TOOL_HOSTS } = require("../src/mitmConfig");
const { log, err } = require("../src/logger");
const fs = require("fs");
const { CONFIG_FILE, DATA_DIR, MITM_DIR } = require("../src/paths");

const args = process.argv.slice(2);
const cmd = args[0];

function printHelp() {
  console.log(`
9R MITM Client — standalone MITM for 9router (v0.1.0)

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
  help                           Show this help

Config file: ${CONFIG_FILE}
Data dir:    ${DATA_DIR}

Examples:
  mitm-client config routerUrl https://9router.example.com
  mitm-client config apiKey sk-xxxx
  mitm-client setup
  sudo mitm-client start
  mitm-client dns-on windsurf
`);
}

async function readSudoPassword() {
  if (!isSudoPasswordRequired()) return "";
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write("sudo password: ");
    const onData = (char) => {
      // mute typed chars (best-effort)
      if (process.stdout.isTTY) process.stdout.write("\b \b");
    };
    process.stdin.on("data", onData);
    rl.question("", (pwd) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      console.log();
      resolve(pwd.trim());
    });
  });
}

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
