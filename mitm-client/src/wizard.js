// AC7 — Setup wizard.
// Interactive flow: setup (CA + trust) → config routerUrl → config apiKey → start → dns-on.
// Reduces 5 commands to 1 for first-time users.

const readline = require("readline");
const fs = require("fs");
const { log, err } = require("./logger");
const { loadConfig, saveConfig } = require("./config");
const { ROOT_CA_CERT_PATH } = require("./cert/rootCA");
const { readSudoPassword } = require("./ui/password");
const { addDNSEntry, checkAllDNSStatus } = require("./dns/dnsConfig");
const { TOOL_HOSTS } = require("./mitmConfig");
const { validateConfigValue } = require("./ui/cli");

function prompt(rl, q, defaultVal) {
  const hint = defaultVal ? ` [${defaultVal}]: ` : ": ";
  return new Promise((resolve) => {
    rl.question(q + hint, (answer) => resolve(answer.trim()));
  });
}

async function runWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  log("╔══════════════════════════════════════════════════════════════╗");
  log("║          9R MITM Client — Setup Wizard                       ║");
  log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  const cfg = loadConfig();

  // ── Step 1: Setup (CA + trust) ─────────────────────────────
  console.log("Step 1/5: Certificate Setup");
  const certExists = fs.existsSync(ROOT_CA_CERT_PATH);
  if (certExists && cfg.certTrusted) {
    console.log("  ✅ Root CA already generated and trusted. Skipping.");
  } else {
    const doSetup = await prompt(rl, "  Generate Root CA and trust it? (y/n)", "y");
    if (doSetup.toLowerCase() === "y" || doSetup === "") {
      console.log("  🔐 Generating Root CA...");
      const { generateRootCA } = require("./cert/rootCA");
      const { trustCert } = require("./cert/install");
      await generateRootCA();
      const ok = trustCert();
      if (ok) {
        saveConfig({ certTrusted: true });
        console.log("  ✅ Root CA generated and trusted.");
      } else {
        console.log("  ⚠️  Cert trust failed. You may need to manually trust the CA.");
      }
    } else {
      console.log("  ⏭ Skipped. You can run 'mitm-client setup' later.");
    }
  }
  console.log();

  // ── Step 2: Config routerUrl ───────────────────────────────
  console.log("Step 2/5: Router URL");
  const routerUrl = await prompt(rl, "  Enter 9router URL", cfg.routerUrl || "http://localhost:20128");
  const urlValue = routerUrl || cfg.routerUrl || "http://localhost:20128";
  const urlValidation = validateConfigValue("routerUrl", urlValue);
  if (urlValidation.ok) {
    saveConfig({ routerUrl: urlValue });
    console.log(`  ✅ routerUrl = ${urlValue}`);
  } else {
    console.log(`  ⚠️  Invalid URL: ${urlValidation.error}. Keeping default.`);
  }
  console.log();

  // ── Step 3: Config apiKey ──────────────────────────────────
  console.log("Step 3/5: API Key");
  const apiKey = await prompt(rl, "  Enter API key", cfg.apiKey ? "(set, press Enter to keep)" : "");
  const keyValue = apiKey || cfg.apiKey;
  if (keyValue) {
    const keyValidation = validateConfigValue("apiKey", keyValue);
    if (keyValidation.ok) {
      saveConfig({ apiKey: keyValue });
      console.log("  ✅ apiKey set");
    } else {
      console.log(`  ⚠️  Invalid API key: ${keyValidation.error}`);
    }
  } else {
    console.log("  ⚠️  No API key set. You can set it later: mitm-client config apiKey <key>");
  }
  console.log();

  // ── Step 4: Start server ───────────────────────────────────
  console.log("Step 4/5: Start MITM Server");
  const startNow = await prompt(rl, "  Start MITM server now? (y/n)", "y");
  if (startNow.toLowerCase() === "y" || startNow === "") {
    console.log("  🚀 Starting MITM server (needs sudo for port 443)...");
    rl.close();
    const { start } = require("./server");
    start();
    return; // start() takes over the process.
  } else {
    console.log("  ⏭ Skipped. Run 'sudo mitm-client start' later.");
  }
  console.log();

  // ── Step 5: Enable DNS redirect ────────────────────────────
  console.log("Step 5/5: DNS Redirect");
  const tools = Object.keys(TOOL_HOSTS);
  console.log(`  Available tools: ${tools.join(", ")}`);
  const toolChoice = await prompt(rl, "  Enable DNS redirect for which tool?", "windsurf");
  const tool = toolChoice || "windsurf";
  if (TOOL_HOSTS[tool]) {
    const doDns = await prompt(rl, `  Enable DNS redirect for ${tool}? (y/n)`, "y");
    if (doDns.toLowerCase() === "y" || doDns === "") {
      const pwd = await readSudoPassword(rl);
      try {
        await addDNSEntry(tool, pwd);
        const cfg2 = loadConfig();
        if (!cfg2.enabledTools.includes(tool)) {
          cfg2.enabledTools.push(tool);
          saveConfig({ enabledTools: cfg2.enabledTools });
        }
        console.log(`  ✅ DNS redirect enabled for ${tool}`);
      } catch (e) {
        console.log(`  ❌ Failed: ${e.message}`);
      }
    }
  } else {
    console.log(`  ⚠️  Unknown tool: ${tool}. Run 'mitm-client dns-on ${tool}' later.`);
  }
  console.log();

  // ── Summary ────────────────────────────────────────────────
  const finalCfg = loadConfig();
  const dns = checkAllDNSStatus();
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          Setup Wizard Complete                               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Router URL:  ${finalCfg.routerUrl}`);
  console.log(`  API Key:     ${finalCfg.apiKey ? "✅ set" : "❌ not set"}`);
  console.log(`  Cert:        ${fs.existsSync(ROOT_CA_CERT_PATH) ? "✅ exists" : "❌ missing"}`);
  console.log(`  DNS active:  ${Object.entries(dns).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`);
  console.log();
  console.log("  Next steps:");
  if (!finalCfg.apiKey) console.log("    • Set API key: mitm-client config apiKey <key>");
  console.log("    • Start server: sudo mitm-client start");
  console.log("    • Check status: mitm-client status");

  rl.close();
}

module.exports = { runWizard };
