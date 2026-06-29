// AC4 — ANSI color helpers (no external deps).
// Degrade gracefully: if stdout is not a TTY, return plain text (no escape codes).
// Colors: green=active, gray=inactive, red=error, yellow=warning, cyan=info.

const RESET = "\x1B[0m";

const CODES = {
  green: "\x1B[32m",
  gray: "\x1B[90m",
  red: "\x1B[31m",
  yellow: "\x1B[33m",
  cyan: "\x1B[36m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
};

// Check once whether color output is supported.
// process.stdout.isTTY === true → terminal supports ANSI.
// Also respect NO_COLOR env var (https://no-color.org/).
function supportsColor() {
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

const HAS_COLOR = supportsColor();

function wrap(color, text) {
  if (!HAS_COLOR) return text;
  const code = CODES[color];
  if (!code) return text;
  return `${code}${text}${RESET}`;
}

// Convenience helpers — each maps to a semantic meaning per AC4.
const green = (t) => wrap("green", t);
const gray = (t) => wrap("gray", t);
const red = (t) => wrap("red", t);
const yellow = (t) => wrap("yellow", t);
const cyan = (t) => wrap("cyan", t);
const bold = (t) => wrap("bold", t);
const dim = (t) => wrap("dim", t);

// Color a log line by level: error→red, warn→yellow, info→cyan, default→plain.
function colorByLevel(level, text) {
  const lv = String(level).toLowerCase();
  if (lv === "error" || lv === "err") return red(text);
  if (lv === "warn" || lv === "warning") return yellow(text);
  if (lv === "info") return cyan(text);
  return text;
}

// Status indicator: running→green, stopped→gray, error→red.
function statusColor(status, text) {
  const s = String(status).toLowerCase();
  if (s === "running" || s === "active" || s === "ok") return green(text);
  if (s === "stopped" || s === "inactive" || s === "off") return gray(text);
  if (s === "error" || s === "fail") return red(text);
  if (s === "warn") return yellow(text);
  return text;
}

module.exports = {
  supportsColor,
  HAS_COLOR,
  green, gray, red, yellow, cyan, bold, dim,
  colorByLevel, statusColor, RESET,
};
