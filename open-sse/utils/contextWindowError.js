const CONTEXT_WINDOW_ERROR_PATTERNS = [
  "context window",
  "context_window_exceeded",
  "context length",
  "context_length_exceeded",
  "too many input tokens",
  "maximum context length",
  "input exceeds",
  "input is too long",
  "input too long",
  "prompt is too long",
  "content_length_exceeds_threshold",
  "content length exceeds threshold",
];

function stringifyError(errorText) {
  if (!errorText) return "";
  if (typeof errorText === "string") return errorText;
  try { return JSON.stringify(errorText); } catch { return String(errorText); }
}

export function isContextWindowError(errorText) {
  const lower = stringifyError(errorText).toLowerCase();
  return CONTEXT_WINDOW_ERROR_PATTERNS.some(pattern => lower.includes(pattern));
}

