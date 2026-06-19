import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function getDataDir() {
  let configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  configured = configured.split("\n")[0].split("\r")[0].trim();

  const candidates = [];
  if (configured && configured.length <= 512 && configured !== "/app/data") {
    candidates.push(configured);
  }
  if (process.platform !== "win32") {
    candidates.push("/app/data");
  }

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (e) {
      if (e?.code !== "EACCES" && e?.code !== "EPERM" && e?.code !== "ENOENT" && e?.code !== "ENAMETOOLONG") {
        throw e;
      }
      console.warn(`[DATA_DIR] '${dir}' not usable`);
    }
  }

  console.warn(`[DATA_DIR] all paths failed → fallback ~/.${APP_NAME}`);
  return defaultDir();
}

export const DATA_DIR = getDataDir();
