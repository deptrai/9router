// Logger utility for cloud

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Production (NODE_ENV=production) defaults to INFO to cut DEBUG noise in
// aggregated logs (Loki/Grafana). Override with LOG_LEVEL=DEBUG|INFO|WARN|ERROR.
function resolveLevel() {
  const envLevel = (process.env.LOG_LEVEL || "").toUpperCase();
  if (envLevel in LOG_LEVELS) return LOG_LEVELS[envLevel];
  return process.env.NODE_ENV === "production" ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG;
}

const LEVEL = resolveLevel();

// Only colorize on an interactive TTY (local dev). In Docker/production there is
// no TTY, so the cyan request line below stays clean text for log shippers.
const USE_COLOR = !!process.stdout.isTTY && process.env.NO_COLOR !== "1";
const CYAN = USE_COLOR ? "\x1b[36m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";

// Strip ANSI escape codes when not colorizing (Docker/production → clean Loki
// logs). Callers across the codebase embed raw `\x1b[..m` inline in messages;
// scrubbing here at the chokepoint covers all of them without touching each site.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function clean(s) {
  return USE_COLOR ? s : String(s).replace(ANSI_RE, "");
}

function formatTime() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function formatData(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function debug(tag, message, data) {
  if (LEVEL <= LOG_LEVELS.DEBUG) {
    const dataStr = data ? ` ${formatData(data)}` : "";
    console.log(clean(`[${formatTime()}] 🔍 [${tag}] ${message}${dataStr}`));
  }
}

export function info(tag, message, data) {
  if (LEVEL <= LOG_LEVELS.INFO) {
    const dataStr = data ? ` ${formatData(data)}` : "";
    console.log(clean(`[${formatTime()}] ℹ️  [${tag}] ${message}${dataStr}`));
  }
}

export function warn(tag, message, data) {
  if (LEVEL <= LOG_LEVELS.WARN) {
    const dataStr = data ? ` ${formatData(data)}` : "";
    console.warn(clean(`[${formatTime()}] ⚠️  [${tag}] ${message}${dataStr}`));
  }
}

export function error(tag, message, data) {
  if (LEVEL <= LOG_LEVELS.ERROR) {
    const dataStr = data ? ` ${formatData(data)}` : "";
    console.error(clean(`[${formatTime()}] ❌ [${tag}] ${message}${dataStr}`));
  }
}

export function request(method, path, extra) {
  const dataStr = extra ? ` ${formatData(extra)}` : "";
  console.log(clean(`${CYAN}[${formatTime()}] 📥 ${method} ${path}${dataStr}${RESET}`));
}

export function response(status, duration, extra) {
  const icon = status < 400 ? "📤" : "💥";
  const dataStr = extra ? ` ${formatData(extra)}` : "";
  console.log(clean(`[${formatTime()}] ${icon} ${status} (${duration}ms)${dataStr}`));
}

export function stream(event, data) {
  const dataStr = data ? ` ${formatData(data)}` : "";
  console.log(clean(`[${formatTime()}] 🌊 [STREAM] ${event}${dataStr}`));
}

// Mask sensitive data
export function maskKey(key) {
  if (!key || key.length < 8) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

