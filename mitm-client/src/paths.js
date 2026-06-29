// Standalone paths — uses ~/.9r-mitm-client as data dir (independent from 9router)
const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "9r-mitm-client";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function getDataDir() {
  let configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  configured = configured.split("\n")[0].split("\r")[0].trim();
  if (configured && configured.length <= 512) {
    try {
      fs.mkdirSync(configured, { recursive: true });
      return configured;
    } catch (e) {
      if (e?.code !== "EACCES" && e?.code !== "EPERM" && e?.code !== "ENOENT") throw e;
    }
  }
  return defaultDir();
}

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// Ensure dirs exist
fs.mkdirSync(MITM_DIR, { recursive: true });

module.exports = { DATA_DIR, MITM_DIR, CONFIG_FILE, APP_NAME };
