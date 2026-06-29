// AC5 — sudo password reading with non-TTY fallback.
// Sources (in priority order):
//   1. Interactive prompt (TTY only)
//   2. Env var SUDO_PASSWORD (CI/automation)
//   3. File ~/.sudo-password (mode 0o600, persistent)
// If none available on non-TTY → warn user.

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { isSudoPasswordRequired } = require("../dns/dnsConfig");

const SUDO_PASSWORD_FILE = path.join(os.homedir(), ".sudo-password");

function readPasswordFromEnv() {
  const pwd = process.env.SUDO_PASSWORD;
  if (pwd && pwd.length > 0) return pwd;
  return null;
}

function readPasswordFromFile(filePath) {
  const f = filePath || SUDO_PASSWORD_FILE;
  try {
    const stat = fs.statSync(f);
    // Security: only accept if file mode is 0o600 (owner read/write only).
    if ((stat.mode & 0o777) !== 0o600) return null;
    return fs.readFileSync(f, "utf8").trim();
  } catch {
    return null;
  }
}

function readSudoPasswordInteractive(rl) {
  return new Promise((resolve) => {
    process.stdout.write("  sudo password: ");
    const onData = () => {
      // mute typed chars (best-effort, only on TTY)
      if (process.stdout.isTTY) process.stdout.write("\b \b");
    };
    process.stdin.on("data", onData);
    rl.question("", (pwd) => {
      process.stdin.removeListener("data", onData);
      console.log();
      resolve(pwd.trim());
    });
  });
}

// Main entry point.
// rl is optional — if not provided, a temporary readline interface is created.
// Returns password string, or "" if no password source available.
async function readSudoPassword(rl) {
  if (!isSudoPasswordRequired()) return "";

  // Non-TTY: try env and file before warning.
  if (!process.stdin.isTTY) {
    const envPwd = readPasswordFromEnv();
    if (envPwd) return envPwd;
    const filePwd = readPasswordFromFile();
    if (filePwd) return filePwd;
    console.error(
      "⚠️  No password source available (non-TTY). " +
      "Set SUDO_PASSWORD env var or create ~/.sudo-password (mode 0o600)."
    );
    return "";
  }

  // TTY: interactive prompt.
  let createdRl = false;
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    createdRl = true;
  }
  const pwd = await readSudoPasswordInteractive(rl);
  if (createdRl) rl.close();
  return pwd;
}

module.exports = {
  readSudoPassword,
  readPasswordFromEnv,
  readPasswordFromFile,
  SUDO_PASSWORD_FILE,
};
