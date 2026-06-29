// AC6 — Config profiles.
// mitm-client profile add <name> <url> <key> — saves profile.
// mitm-client profile list — shows all.
// mitm-client profile use <name> — switches active config (routerUrl + apiKey).
// mitm-client profile remove <name> — deletes.
// Default profile = "local" (localhost:20128).
// Profiles stored in ~/.9r-mitm-client/profiles.json (mode 0o600).

const fs = require("fs");
const path = require("path");
const { log, err } = require("./logger");
const { loadConfig, saveConfig } = require("./config");
const { CONFIG_FILE, DATA_DIR } = require("./paths");

const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

const DEFAULT_PROFILES = {
  local: {
    routerUrl: "http://localhost:20128",
    apiKey: "",
    description: "Local 9router (default)",
  },
};

// ── Load / save profiles ──────────────────────────────────────

function loadProfiles() {
  try {
    const raw = fs.readFileSync(PROFILES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PROFILES, ...parsed };
  } catch {
    return { ...DEFAULT_PROFILES };
  }
}

function saveProfiles(profiles) {
  // Ensure data dir exists.
  const dir = path.dirname(PROFILES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), { mode: 0o600 });
  // Ensure mode 0o600 even if file already existed with different mode.
  try { fs.chmodSync(PROFILES_FILE, 0o600); } catch {}
  return profiles;
}

// ── Profile operations ────────────────────────────────────────

function addProfile(name, routerUrl, apiKey, description) {
  if (!name) { err("Usage: profile add <name> <url> <key> [description]"); return { ok: false }; }
  if (!routerUrl) { err("routerUrl is required"); return { ok: false }; }
  // Validate URL format.
  try {
    const parsed = new URL(routerUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      err("Invalid protocol — only http/https allowed");
      return { ok: false };
    }
  } catch {
    err("Invalid URL format");
    return { ok: false };
  }

  const profiles = loadProfiles();
  profiles[name] = { routerUrl, apiKey: apiKey || "", description: description || "" };
  saveProfiles(profiles);
  log(`✅ Profile "${name}" saved: ${routerUrl}`);
  return { ok: true, name, routerUrl };
}

function listProfiles() {
  const profiles = loadProfiles();
  const cfg = loadConfig();
  // Detect active profile by matching routerUrl + apiKey.
  let activeProfile = null;
  for (const [name, p] of Object.entries(profiles)) {
    if (p.routerUrl === cfg.routerUrl && p.apiKey === cfg.apiKey) {
      activeProfile = name;
      break;
    }
  }

  const list = [];
  for (const [name, p] of Object.entries(profiles)) {
    list.push({
      name,
      routerUrl: p.routerUrl,
      apiKey: p.apiKey ? `${p.apiKey.substring(0, 8)}...` : "(not set)",
      description: p.description || "",
      active: name === activeProfile,
    });
  }
  return { profiles: list, activeProfile };
}

function useProfile(name) {
  const profiles = loadProfiles();
  if (!profiles[name]) {
    err(`Profile "${name}" not found. Run 'mitm-client profile list' to see available profiles.`);
    return { ok: false };
  }
  const p = profiles[name];
  saveConfig({ routerUrl: p.routerUrl, apiKey: p.apiKey });
  log(`✅ Switched to profile "${name}": ${p.routerUrl}`);
  return { ok: true, name, routerUrl: p.routerUrl };
}

function removeProfile(name) {
  if (name === "local") {
    err("Cannot remove the default 'local' profile.");
    return { ok: false };
  }
  const profiles = loadProfiles();
  if (!profiles[name]) {
    err(`Profile "${name}" not found.`);
    return { ok: false };
  }
  delete profiles[name];
  saveProfiles(profiles);
  log(`✅ Profile "${name}" removed.`);
  return { ok: true };
}

module.exports = {
  loadProfiles, saveProfiles,
  addProfile, listProfiles, useProfile, removeProfile,
  PROFILES_FILE, DEFAULT_PROFILES,
};
