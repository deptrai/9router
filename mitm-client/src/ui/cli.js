// Terminal UI — interactive menu using plain readline (no external deps).
// AC1: split layout (header + live logs), `l` toggle full-screen
// AC2: connection counter (poll /_mitm_health every 2s)
// AC3: inline config editor with validation
// AC4: ANSI color coding with TTY guard
// AC5: non-TTY fallback to basic numbered menu

const readline = require("readline");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { loadConfig, saveConfig } = require("../config");
const { checkAllDNSStatus, addDNSEntry, removeDNSEntry, removeAllDNSEntries } = require("../dns/dnsConfig");
const { TOOL_HOSTS } = require("../mitmConfig");
const { log, err } = require("../logger");
const { getServerLogFile } = require("../logger");
const { ROOT_CA_CERT_PATH } = require("../cert/rootCA");
const { DATA_DIR } = require("../paths");
const colors = require("./colors");
const { readSudoPassword } = require("./password");

const TOOLS = Object.keys(TOOL_HOSTS);

// ── Terminal helpers ──────────────────────────────────────────

function clear() {
  // AC4 — only emit clear-screen escape codes on TTY (avoid ANSI in piped output).
  if (process.stdout.isTTY) process.stdout.write("\x1B[2J\x1B[H");
}

function termWidth() { return process.stdout.columns || 80; }
function termHeight() { return process.stdout.rows || 24; }

function isServerRunning() {
  try {
    const out = require("child_process").execSync(
      "lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }
    ).trim();
    return !!out;
  } catch { return false; }
}

// ── Stats poller (AC2) ────────────────────────────────────────

function pollHealth() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "localhost",
      port: 443,
      path: "/_mitm_health",
      method: "GET",
      rejectUnauthorized: false,
      timeout: 3000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Log tailer (AC1) ──────────────────────────────────────────

function createLogTailer() {
  const logFile = getServerLogFile();
  let lines = [];
  let watcher = null;

  function refresh() {
    try {
      const content = fs.readFileSync(logFile, "utf8");
      lines = content.split("\n").filter((l) => l.length > 0);
      // Cap at 200 lines in memory.
      if (lines.length > 200) lines = lines.slice(-200);
    } catch { /* file may not exist yet */ }
  }

  function start() {
    refresh();
    try {
      watcher = fs.watch(logFile, () => refresh());
    } catch { /* file may not exist yet — retry on next refresh */ }
    // Also poll every 1s as fallback (fs.watch can miss events on some platforms).
    setInterval(refresh, 1000).unref();
  }

  function stop() {
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  }

  function getLines(n) {
    return lines.slice(-n);
  }

  return { start, stop, getLines, refresh };
}

// Color a log line by its level tag: [INFO], [ERROR], [WARN].
function colorLogLine(line) {
  const m = line.match(/\[(INFO|ERROR|ERR|WARN|WARNING)\]/i);
  if (m) return colors.colorByLevel(m[1], line);
  return line;
}

// ── Screen rendering ──────────────────────────────────────────

function renderHeader(health, cfg, dns) {
  const running = health && health.ok;
  const st = health && health.stats ? health.stats : { active: 0, total: 0, success: 0, error: 0 };
  const w = termWidth();

  console.log(colors.bold("╔══════════════════════════════════════════════════════════════╗"));
  console.log(colors.bold("║          9R MITM Client — Terminal Manager                   ║"));
  console.log(colors.bold("╚══════════════════════════════════════════════════════════════╝"));

  // Status + stats line (AC2 + AC4).
  const statusStr = running
    ? colors.statusColor("running", "🟢 running")
    : colors.statusColor("stopped", "⚪ stopped");
  const statsStr =
    `Active:${colors.cyan(st.active)}  ` +
    `Total:${colors.bold(st.total)}  ` +
    `${colors.green("✓" + st.success)}  ` +
    `${colors.red("✗" + st.error)}`;
  console.log(`  Server: ${statusStr} (port 443)  ${statsStr}`);
  console.log(`  Router:    ${cfg.routerUrl}`);
  console.log(`  API key:   ${cfg.apiKey ? colors.green("✅ set") : colors.gray("❌ not set")}`);
  console.log(`  Cert:      ${fs.existsSync(ROOT_CA_CERT_PATH) ? colors.green("✅ exists") : colors.red("❌ missing — run setup")}`);
  console.log(`  Debug:     ${cfg.mitmDebug ? colors.yellow("ON") : colors.gray("off")}`);
  console.log("  ── DNS redirect ──");
  for (const t of TOOLS) {
    const active = dns[t];
    const icon = active ? colors.green("🟢") : colors.gray("⚪");
    console.log(`   ${icon} ${t.padEnd(12)} ${TOOL_HOSTS[t].join(", ")}`);
  }
}

function renderLogsPanel(tailer, lineCount) {
  const lines = tailer.getLines(lineCount);
  console.log(colors.dim("  ── Live Logs" + " ".repeat(Math.max(0, termWidth() - 30)) + "[l] fullscreen ──"));
  if (lines.length === 0) {
    console.log(colors.gray("  (no logs yet — start server and send requests)"));
  } else {
    for (const line of lines) {
      // Truncate long lines to terminal width.
      const display = line.length > termWidth() - 2
        ? line.substring(0, termWidth() - 5) + "..."
        : line;
      console.log("  " + colorLogLine(display));
    }
  }
}

function renderMenu(fullScreen) {
  if (fullScreen) {
    console.log(colors.dim("  [l] back to split view  [r] refresh  [q] quit"));
  } else {
    console.log(colors.dim("  [1] Start  [2] Stop  [3-5] DNS  [6-9] Config/Setup  [l] logs  [r] refresh  [q] quit"));
  }
}

function render(state) {
  clear();
  const { health, cfg, dns, tailer, fullScreen } = state;
  if (fullScreen) {
    // Full-screen logs: fill screen with log lines.
    const logLines = termHeight() - 3; // leave room for title + menu
    console.log(colors.bold("  9R MITM Client — Full-screen Logs"));
    renderLogsPanel(tailer, logLines);
    renderMenu(true);
  } else {
    renderHeader(health, cfg, dns);
    console.log("");
    // Split layout: logs panel gets remaining screen space.
    const headerLines = 13; // approximate header height
    const menuLines = 2;
    const logLines = Math.max(5, termHeight() - headerLines - menuLines);
    renderLogsPanel(tailer, logLines);
    renderMenu(false);
  }
}

// ── Inline config editor (AC3) ────────────────────────────────

function validateConfigValue(key, value) {
  if (key === "routerUrl") {
    if (!value) return { ok: false, error: "routerUrl cannot be empty" };
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "Invalid protocol — only http/https allowed" };
      }
    } catch {
      return { ok: false, error: "Invalid URL format" };
    }
    return { ok: true };
  }
  if (key === "apiKey") {
    if (!value || value.trim().length === 0) return { ok: false, error: "apiKey cannot be empty" };
    return { ok: true };
  }
  if (key === "mitmDebug" || key === "certTrusted") {
    // Boolean toggle — no validation needed (toggled, not typed).
    return { ok: true };
  }
  return { ok: false, error: `Unknown config key: ${key}` };
}

// Prompt for inline input while temporarily exiting raw mode.
async function promptInline(rl, question, defaultVal) {
  // Remove keypress listener during prompt.
  const listeners = process.stdin.listeners("keypress").slice();
  listeners.forEach((l) => process.stdin.removeListener("keypress", l));
  process.stdin.setRawMode(false);

  const hint = defaultVal ? ` [${defaultVal}]: ` : ": ";
  return new Promise((resolve) => {
    rl.question(question + hint, (answer) => {
      process.stdin.setRawMode(true);
      // Restore keypress listeners.
      listeners.forEach((l) => process.stdin.on("keypress", l));
      resolve(answer.trim());
    });
  });
}

function showInlineMessage(msg, color) {
  const colored = color ? color(msg) : msg;
  process.stdout.write("\r\x1B[K" + colored + "\n");
}

async function editConfigField(rl, key) {
  const cfg = loadConfig();
  if (key === "mitmDebug" || key === "certTrusted") {
    // Boolean toggle — no inline prompt needed.
    const newVal = !cfg[key];
    saveConfig({ [key]: newVal });
    showInlineMessage(`  ✅ ${key} = ${newVal}`, colors.green);
    await sleep(800);
    return;
  }

  const current = cfg[key] || "";
  const answer = await promptInline(rl, `  Edit ${key}`, current);
  const value = answer || current; // empty → keep current

  const validation = validateConfigValue(key, value);
  if (!validation.ok) {
    showInlineMessage(`  ❌ ${validation.error}`, colors.red);
    await sleep(1500);
    return;
  }

  saveConfig({ [key]: value });
  showInlineMessage(`  ✅ ${key} saved`, colors.green);
  await sleep(800);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Action handlers ───────────────────────────────────────────

async function handleStart(rl) {
  showInlineMessage("  Starting MITM server (foreground)...", colors.cyan);
  await sleep(300);
  const { start } = require("../server");
  // Close TUI resources before handing over to server.
  cleanupTui(rl);
  start();
}

async function handleStop(rl) {
  try {
    const out = require("child_process").execSync(
      "lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }
    ).trim();
    if (out) {
      out.split("\n").forEach((pid) => {
        try { process.kill(Number(pid), "SIGTERM"); } catch {}
      });
      showInlineMessage("  ⏹ MITM server stopped", colors.green);
    } else {
      showInlineMessage("  MITM server not running", colors.gray);
    }
  } catch {
    showInlineMessage("  MITM server not running", colors.gray);
  }
  await sleep(800);
}

async function handleDnsToggle(rl, tool) {
  try {
    const out = require("child_process").execSync(
      "lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }
    ).trim();
    if (out) showInlineMessage("  ⚠️  MITM server running — DNS toggle may disrupt in-flight requests", colors.yellow);
  } catch {}
  await sleep(600);

  const dns = checkAllDNSStatus();
  const pwd = await readSudoPassword(rl);
  try {
    if (dns[tool]) { await removeDNSEntry(tool, pwd); }
    else { await addDNSEntry(tool, pwd); }
  } catch (e) { showInlineMessage(`  ❌ ${e.message}`, colors.red); }
  await sleep(500);
}

async function handleDnsAllToggle(rl) {
  const pwd = await readSudoPassword(rl);
  const dns = checkAllDNSStatus();
  const anyActive = Object.values(dns).some(Boolean);
  if (anyActive) {
    const failed = await removeAllDNSEntries(pwd);
    saveConfig({ enabledTools: failed });
  } else {
    const succeeded = [];
    for (const t of TOOLS) {
      try { await addDNSEntry(t, pwd); succeeded.push(t); }
      catch (e) { showInlineMessage(`  ❌ ${t}: ${e.message}`, colors.red); }
    }
    saveConfig({ enabledTools: succeeded });
  }
  await sleep(500);
}

async function handleSetup(rl) {
  showInlineMessage("  🔐 Generating Root CA...", colors.cyan);
  const { generateRootCA } = require("../cert/rootCA");
  const { trustCert } = require("../cert/install");
  await generateRootCA();
  trustCert();
  saveConfig({ certTrusted: true });
  showInlineMessage("  ✅ Setup complete", colors.green);
  await sleep(1000);
}

// ── Enhanced TUI (TTY mode) ───────────────────────────────────

function cleanupTui(rl) {
  try { process.stdin.setRawMode(false); } catch {}
  try { process.stdin.pause(); } catch {}
  rl.close();
}

async function runTuiEnhanced() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const tailer = createLogTailer();
  tailer.start();

  let fullScreen = false;
  let running = true;
  let currentHealth = null;

  // Periodic refresh: poll health every 2s (AC2).
  const healthTimer = setInterval(async () => {
    if (!running) return;
    currentHealth = await pollHealth();
    renderState();
  }, 2000);
  healthTimer.unref();

  // Initial health poll.
  pollHealth().then((h) => { currentHealth = h; renderState(); });

  function renderState() {
    const cfg = loadConfig();
    const dns = checkAllDNSStatus();
    render({ health: currentHealth, cfg, dns, tailer, fullScreen });
  }

  // Initial render.
  renderState();

  // Keypress handler.
  const onKeypress = async (str, key) => {
    if (!running) return;

    // Ctrl+C → quit.
    if (key && key.ctrl && key.name === "c") { running = false; return; }

    const ch = (str || "").toLowerCase();
    const name = key ? key.name : "";

    if (name === "q" || ch === "q") {
      running = false;
    } else if (name === "l" || ch === "l") {
      fullScreen = !fullScreen;
      renderState();
    } else if (name === "r" || ch === "r") {
      tailer.refresh();
      currentHealth = await pollHealth();
      renderState();
    } else if (ch === "1") {
      await handleStart(rl);
    } else if (ch === "2") {
      await handleStop(rl);
      renderState();
    } else if (ch === "3") {
      await handleDnsToggle(rl, "windsurf");
      renderState();
    } else if (ch === "4") {
      await handleDnsToggle(rl, "antigravity");
      renderState();
    } else if (ch === "5") {
      await handleDnsAllToggle(rl);
      renderState();
    } else if (ch === "6") {
      await editConfigField(rl, "routerUrl");
      renderState();
    } else if (ch === "7") {
      await editConfigField(rl, "apiKey");
      renderState();
    } else if (ch === "8") {
      await editConfigField(rl, "mitmDebug");
      renderState();
    } else if (ch === "9") {
      await handleSetup(rl);
      renderState();
    }
  };

  process.stdin.on("keypress", onKeypress);

  // Wait until running becomes false.
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (!running) { clearInterval(check); resolve(); }
    }, 100);
  });

  // Cleanup.
  process.stdin.removeListener("keypress", onKeypress);
  clearInterval(healthTimer);
  tailer.stop();
  cleanupTui(rl);
  clear();
  console.log("Bye!");
}

// ── Non-TTY fallback (AC5) ────────────────────────────────────

function prompt(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function runTuiNonTty() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    clear();
    // Basic header (no colors — non-TTY).
    const cfg = loadConfig();
    const dns = checkAllDNSStatus();
    let running = isServerRunning();

    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║          9R MITM Client — Terminal Manager                   ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`  Server:    ${running ? "running" : "stopped"} (port 443)`);
    console.log(`  Router:    ${cfg.routerUrl}`);
    console.log(`  API key:   ${cfg.apiKey ? "set" : "not set"}`);
    console.log(`  Cert:      ${fs.existsSync(ROOT_CA_CERT_PATH) ? "exists" : "missing — run setup"}`);
    console.log(`  Debug:     ${cfg.mitmDebug ? "ON" : "off"}`);
    console.log("  ── DNS redirect ──");
    for (const t of TOOLS) {
      console.log(`   ${dns[t] ? "+" : "-"} ${t.padEnd(12)} ${TOOL_HOSTS[t].join(", ")}`);
    }
    console.log("");
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
        const out = require("child_process").execSync(
          "lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }
        ).trim();
        if (out) out.split("\n").forEach((pid) => { try { process.kill(Number(pid), "SIGTERM"); } catch {} });
        log("⏹ MITM server stopped");
      } catch { log("MITM server not running"); }
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "3" || choice === "4") {
      const tool = choice === "3" ? "windsurf" : "antigravity";
      try {
        const out = require("child_process").execSync(
          "lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null", { encoding: "utf-8" }
        ).trim();
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
        saveConfig({ enabledTools: failed });
      } else {
        const succeeded = [];
        for (const t of TOOLS) { try { await addDNSEntry(t, pwd); succeeded.push(t); } catch (e) { err(`${t}: ${e.message}`); } }
        saveConfig({ enabledTools: succeeded });
      }
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "6") {
      const cfg = loadConfig();
      const url = (await prompt(rl, `  routerUrl [${cfg.routerUrl}]: `)).trim();
      const value = url || cfg.routerUrl;
      const validation = validateConfigValue("routerUrl", value);
      if (validation.ok) { saveConfig({ routerUrl: value }); log(`routerUrl = ${value}`); }
      else { err(validation.error); }
      await prompt(rl, "\n  Press Enter to continue...");
    } else if (choice === "7") {
      const cfg = loadConfig();
      const key = (await prompt(rl, `  apiKey [${cfg.apiKey ? "(set)" : ""}]: `)).trim();
      const value = key || cfg.apiKey;
      const validation = validateConfigValue("apiKey", value);
      if (validation.ok) { saveConfig({ apiKey: value }); log("apiKey set"); }
      else { err(validation.error); }
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
      const logDir = path.join(DATA_DIR, "logs", "mitm");
      if (!fs.existsSync(logDir)) { log("No logs yet"); }
      else {
        const files = fs.readdirSync(logDir).sort().slice(-5);
        for (const f of files) {
          console.log(`\n=== ${f} ===`);
          console.log(fs.readFileSync(path.join(logDir, f), "utf8").slice(0, 2000));
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

// ── Entry point ───────────────────────────────────────────────

async function runTui() {
  // AC5 — detect TTY: use enhanced TUI on TTY, basic menu on non-TTY.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await runTuiEnhanced();
  } else {
    await runTuiNonTty();
  }
}

module.exports = { runTui, validateConfigValue };
