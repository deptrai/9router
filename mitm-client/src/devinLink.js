// AC3 — Link/unlink Devin CLI credentials.toml.
// Conditional on AC1 spike: if Devin CLI does NOT honor DNS redirect, this module
// backs up credentials.toml → credentials.toml.bak (atomic: write temp + rename),
// sets api_server_url to https://server.codeium.com (DNS redirect handles rest).
// unlink-devin restores from backup.

const fs = require("fs");
const path = require("path");
const { findDevinInstall, parseSimpleToml } = require("./devinDetect");
const { log, err } = require("./logger");

const TARGET_API_SERVER_URL = "https://server.codeium.com";

// ── TOML serialization (simple key=value) ─────────────────────

function serializeSimpleToml(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      lines.push(`${key} = "${value}"`);
    } else if (typeof value === "boolean") {
      lines.push(`${key} = ${value}`);
    } else if (typeof value === "number") {
      lines.push(`${key} = ${value}`);
    } else {
      lines.push(`${key} = "${String(value)}"`);
    }
  }
  return lines.join("\n") + "\n";
}

// ── Atomic write (temp + rename) ──────────────────────────────

function atomicWriteFile(target, content) {
  const tmp = `${target}.9r-tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, target);
    // Preserve file mode 0o600 for sensitive files (credentials.toml).
    try { fs.chmodSync(target, 0o600); } catch {}
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ── Link: backup + modify api_server_url ──────────────────────

function linkDevin(options = {}) {
  const { confirm = true, skipConfirm = false } = options;
  const install = findDevinInstall();

  if (!install) {
    err("Devin CLI not found. Run 'mitm-client detect-devin' first.");
    return { ok: false, error: "Devin CLI not found" };
  }

  if (!install.credentialsPath) {
    err("credentials.toml not found in Devin CLI install dir.");
    return { ok: false, error: "credentials.toml not found" };
  }

  const credPath = install.credentialsPath;
  const backupPath = `${credPath}.bak`;

  // Read current credentials.
  let content;
  try {
    content = fs.readFileSync(credPath, "utf8");
  } catch (e) {
    err(`Failed to read credentials.toml: ${e.message}`);
    return { ok: false, error: e.message };
  }

  const credentials = parseSimpleToml(content);
  const oldUrl = credentials.api_server_url || null;

  // Check if already linked.
  if (oldUrl === TARGET_API_SERVER_URL) {
    log("ℹ️  Devin CLI already linked (api_server_url already set to target).");
    return { ok: true, alreadyLinked: true, oldUrl, newUrl: TARGET_API_SERVER_URL, backupPath: fs.existsSync(backupPath) ? backupPath : null };
  }

  // Check if backup already exists (don't overwrite existing backup).
  if (!fs.existsSync(backupPath)) {
    // Create backup (atomic).
    try {
      atomicWriteFile(backupPath, content);
      log(`📦 Backup created: ${backupPath}`);
    } catch (e) {
      err(`Failed to create backup: ${e.message}`);
      return { ok: false, error: `Backup failed: ${e.message}` };
    }
  } else {
    log(`ℹ️  Backup already exists: ${backupPath} (not overwriting)`);
  }

  // Modify api_server_url.
  credentials.api_server_url = TARGET_API_SERVER_URL;
  const newContent = serializeSimpleToml(credentials);

  try {
    atomicWriteFile(credPath, newContent);
    log(`✅ Linked Devin CLI: api_server_url → ${TARGET_API_SERVER_URL}`);
    log(`   Old URL: ${oldUrl || "(not set)"}`);
    log(`   New URL: ${TARGET_API_SERVER_URL}`);
    log(`   Backup:  ${backupPath}`);
    return { ok: true, oldUrl, newUrl: TARGET_API_SERVER_URL, backupPath };
  } catch (e) {
    err(`Failed to write credentials.toml: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── Unlink: restore from backup ───────────────────────────────

function unlinkDevin() {
  const install = findDevinInstall();

  if (!install) {
    err("Devin CLI not found.");
    return { ok: false, error: "Devin CLI not found" };
  }

  if (!install.credentialsPath) {
    err("credentials.toml not found.");
    return { ok: false, error: "credentials.toml not found" };
  }

  const credPath = install.credentialsPath;
  const backupPath = `${credPath}.bak`;

  if (!fs.existsSync(backupPath)) {
    err("No backup found. Cannot restore — credentials.toml may not have been linked.");
    return { ok: false, error: "No backup found" };
  }

  // Restore from backup (atomic).
  try {
    const backupContent = fs.readFileSync(backupPath, "utf8");
    atomicWriteFile(credPath, backupContent);
    log(`✅ Unlinked Devin CLI: credentials.toml restored from backup.`);
    log(`   Restored from: ${backupPath}`);
    // Remove backup after successful restore.
    try { fs.unlinkSync(backupPath); log(`   Backup removed: ${backupPath}`); } catch {}
    return { ok: true, backupPath };
  } catch (e) {
    err(`Failed to restore credentials.toml: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { linkDevin, unlinkDevin, serializeSimpleToml, atomicWriteFile, TARGET_API_SERVER_URL };
