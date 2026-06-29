// Persistent user config — stored in ~/.9r-mitm-client/config.json
// Holds: remote 9router URL, API key, enabled tools, MITM debug flag.
const fs = require("fs");
const { CONFIG_FILE } = require("./paths");

const DEFAULTS = {
  routerUrl: "http://localhost:20128",
  apiKey: "",
  enabledTools: [],
  mitmDebug: false,
  certTrusted: false,
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  const merged = { ...loadConfig(), ...cfg };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

function get(key) {
  return loadConfig()[key];
}

function set(key, value) {
  const cfg = loadConfig();
  cfg[key] = value;
  saveConfig(cfg);
  return value;
}

module.exports = { loadConfig, saveConfig, get, set, DEFAULTS };
