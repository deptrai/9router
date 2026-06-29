// Terminal UI — interactive menu using plain readline (no external deps).
const readline = require("readline");
const { loadConfig, saveConfig } = require("../config");
const { checkAllDNSStatus, addDNSEntry, removeDNSEntry, removeAllDNSEntries, isSudoPasswordRequired } = require("../dns/dnsConfig");
const { TOOL_HOSTS } = require("../mitmConfig");
const { log, err } = require("../logger");
const fs = require("fs");
const { ROOT_CA_CERT_PATH } = require("../cert/rootCA");
const { CONFIG_FILE } = require("../paths");

const TOOLS = Object.keys(TOOL_HOSTS);

function clear() { process.stdout.write("\x1B[2J\x1B[H"); }

function header() {
  const cfg = loadConfig();
  const dns = checkAllDNSStatus();
  let running = false;
  try {
    const out = require("child_process").execSync("lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }).trim();
    if (out) running = true;
  } catch {}

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          9R MITM Client — Terminal Manager                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Router:    ${cfg.routerUrl}`);
  console.log(`  API key:   ${cfg.apiKey ? "✅ set" : "❌ not set"}`);
  console.log(`  Server:    ${running ? "🟢 running" : "⚪ stopped"} (port 443)`);
  console.log(`  Cert:      ${fs.existsSync(ROOT_CA_CERT_PATH) ? "✅ exists" : "❌ missing — run setup"}`);
  console.log(`  Debug:     ${cfg.mitmDebug ? "ON" : "off"}`);
  console.log("  ── DNS redirect ──");
  for (const t of TOOLS) {
    const active = dns[t];
    console.log(`   ${active ? "🟢" : "⚪"} ${t.padEnd(12)} ${TOOL_HOSTS[t].join(", ")}`);
  }
  console.log("");
}

async function readSudoPassword(rl) {
  if (!isSudoPasswordRequired()) return "";
  return new Promise((resolve) => {
    process.stdout.write("  sudo password: ");
    const onData = (char) => { if (process.stdout.isTTY) process.stdout.write("\b \b"); };
    process.stdin.on("data", onData);
    rl.question("", (pwd) => {
      process.stdin.removeListener("data", onData);
      console.log();
      resolve(pwd.trim());
    });
  });
}

function prompt(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function runTui() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    clear();
    header();
    console.log("  [1] Start MITM server   (sudo)");
    console.log("  [2] Stop MITM server");
    console.log("  [3] Toggle DNS: windsurf");
    console.log("  [4] Toggle DNS: antigravity");
    console.log("  [5] Toggle DNS: all tools");
    console.log("  [6] Config: routerUrl");
    console.log("  [7] Config: apiKey");
    console.log("  [8] Config: toggle mitmDebug");
    console.log("  [9] Run setup (generate CA + trust)");
    console.log("  [l] View recent logs");
    console.log("  [r] Refresh");
    console.log("  [q] Quit");
    console.log("");

    const choice = (await prompt(rl, "  > ")).trim().toLowerCase();

    if (choice === "q") break;
    else if (choice === "1") {
      console.log("\n  Starting MITM server (foreground)...");
      const { start } = require("../server");
      rl.close();
      start();
      return;
    } else if (choice === "2") {
      try {
        const out = require("child_process").execSync("lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }).trim();
        if (out) out.split("\n").forEach(pid => { try { process.kill(Number(pid), "SIGTERM"); } catch {} });
        log("⏹ MITM server stopped");
      } catch { log("MITM server not running"); }
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "3" || choice === "4") {
      const tool = choice === "3" ? "windsurf" : "antigravity";
      // P14: warn if server is running — DNS toggle mid-request may cause passthrough failure.
      try {
        const out = require("child_process").execSync("lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }).trim();
        if (out) console.log("  ⚠️  MITM server is running — DNS toggle may disrupt in-flight requests");
      } catch {}
      const dns = checkAllDNSStatus();
      const pwd = await readSudoPassword(rl);
      try {
        if (dns[tool]) { await removeDNSEntry(tool, pwd); }
        else { await addDNSEntry(tool, pwd); }
      } catch (e) { err(e.message); }
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "5") {
      const pwd = await readSudoPassword(rl);
      const dns = checkAllDNSStatus();
      const anyActive = Object.values(dns).some(Boolean);
      if (anyActive) {
        const failed = await removeAllDNSEntries(pwd);
        // P13: only clear enabledTools for tools that were actually removed.
        saveConfig({ enabledTools: failed });
      } else {
        const succeeded = [];
        for (const t of TOOLS) { try { await addDNSEntry(t, pwd); succeeded.push(t); } catch (e) { err(`${t}: ${e.message}`); } }
        saveConfig({ enabledTools: succeeded });
      }
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "6") {
      const url = (await prompt(rl, "  routerUrl: ")).trim();
      // P6: validate URL format before saving — reject non-http(s) protocols.
      if (url) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            err("Invalid protocol — only http/https allowed");
          } else {
            saveConfig({ routerUrl: url });
            log(`routerUrl = ${url}`);
          }
        } catch { err("Invalid URL format"); }
      }
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "7") {
      const key = (await prompt(rl, "  apiKey: ")).trim();
      if (key) { saveConfig({ apiKey: key }); log("apiKey set"); }
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "8") {
      const cfg = loadConfig();
      saveConfig({ mitmDebug: !cfg.mitmDebug });
      log(`mitmDebug = ${!cfg.mitmDebug}`);
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "9") {
      const { generateRootCA } = require("../cert/rootCA");
      const { trustCert } = require("../cert/install");
      await generateRootCA();
      trustCert();
      saveConfig({ certTrusted: true });
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "l") {
      const logDir = require("path").join(require("../paths").DATA_DIR, "logs", "mitm");
      if (!fs.existsSync(logDir)) { log("No logs yet"); }
      else {
        const files = fs.readdirSync(logDir).sort().slice(-5);
        for (const f of files) {
          console.log(`\n=== ${f} ===`);
          console.log(fs.readFileSync(require("path").join(logDir, f), "utf8").slice(0, 2000));
        }
      }
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "r") {
      // just refresh (loop continues)
    }
  }
  rl.close();
  console.log("Bye!");
}

module.exports = { runTui };
