const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_KIRO_AUTO_COMPACT_LIMIT_TOKENS = 180_000;
const DEFAULT_KIRO_KEEP_HEAD = 2;
const DEFAULT_KIRO_KEEP_TAIL = 24;
const MIN_KIRO_KEEP_TAIL = 4;
const AUTO_COMPACT_MARKER = "[9router auto-compact]";

function readPositiveIntEnv(name, fallback) {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function estimatePayloadBytes(payload) {
  try {
    return new TextEncoder().encode(JSON.stringify(payload || {})).length;
  } catch {
    return 0;
  }
}

export function estimatePayloadTokens(payload) {
  return Math.ceil(estimatePayloadBytes(payload) / CHARS_PER_TOKEN_ESTIMATE);
}

export function getProviderAutoCompactLimit(provider) {
  if (provider !== "kiro") return null;
  return readPositiveIntEnv("KIRO_AUTO_COMPACT_LIMIT_TOKENS", DEFAULT_KIRO_AUTO_COMPACT_LIMIT_TOKENS);
}

function getKiroMessageKind(item) {
  if (item?.userInputMessage) return "user";
  if (item?.assistantResponseMessage) return "assistant";
  return null;
}

function appendContent(target, source, path) {
  const left = target?.[path]?.content || "";
  const right = source?.[path]?.content || "";
  target[path].content = [left, right].filter(Boolean).join("\n\n");
}

function mergeAdjacentKiroHistory(history) {
  const merged = [];
  for (const item of history) {
    const kind = getKiroMessageKind(item);
    const last = merged[merged.length - 1];
    if (kind && getKiroMessageKind(last) === kind) {
      if (kind === "user") appendContent(last, item, "userInputMessage");
      else appendContent(last, item, "assistantResponseMessage");
      continue;
    }
    merged.push(item);
  }
  return merged;
}

function setCurrentMessageNotice(state, originalContent, omittedCount, headCount, tailCount) {
  const userInput = state?.currentMessage?.userInputMessage;
  if (!userInput) return false;
  const notice = `${AUTO_COMPACT_MARKER} Earlier Kiro history was shortened before upstream dispatch because this session exceeded the provider content-length threshold. Omitted ${omittedCount} older history entries; kept ${headCount} initial and ${tailCount} recent entries.`;
  userInput.content = `${notice}\n\n${originalContent || "continue"}`;
  return true;
}

function buildKiroHistoryCandidate(history, keepHead, keepTail) {
  const headCount = Math.min(keepHead, history.length);
  const maxTailStart = Math.max(headCount, history.length - keepTail);
  const head = history.slice(0, headCount);
  const tail = keepTail > 0 ? history.slice(maxTailStart) : [];
  const omittedCount = Math.max(0, history.length - head.length - tail.length);
  return {
    history: mergeAdjacentKiroHistory([...head, ...tail]),
    omittedCount,
    headCount: head.length,
    tailCount: tail.length,
  };
}

export function compactKiroPayload(body, options = {}) {
  const limitTokens = options.limitTokens || getProviderAutoCompactLimit("kiro");
  const beforeBytes = estimatePayloadBytes(body);
  const beforeTokens = Math.ceil(beforeBytes / CHARS_PER_TOKEN_ESTIMATE);
  if (!limitTokens || beforeTokens <= limitTokens) {
    return { applied: false, beforeBytes, afterBytes: beforeBytes, beforeTokens, afterTokens: beforeTokens, limitTokens };
  }

  const state = body?.conversationState;
  const originalHistory = Array.isArray(state?.history) ? state.history : [];
  const userInput = state?.currentMessage?.userInputMessage;
  if (!state || !userInput || originalHistory.length === 0) {
    return { applied: false, tooLarge: true, beforeBytes, afterBytes: beforeBytes, beforeTokens, afterTokens: beforeTokens, limitTokens };
  }

  const originalContent = typeof userInput.content === "string" ? userInput.content : String(userInput.content || "");
  const keepHead = options.keepHead ?? readPositiveIntEnv("KIRO_AUTO_COMPACT_KEEP_HEAD", DEFAULT_KIRO_KEEP_HEAD);
  const initialTail = options.keepTail ?? readPositiveIntEnv("KIRO_AUTO_COMPACT_KEEP_TAIL", DEFAULT_KIRO_KEEP_TAIL);
  const minTail = options.minTail ?? MIN_KIRO_KEEP_TAIL;

  let best = null;
  const attemptedTailCounts = [];
  for (let tailCount = Math.min(initialTail, originalHistory.length); tailCount >= minTail; tailCount = Math.floor(tailCount * 0.7)) {
    if (attemptedTailCounts.includes(tailCount)) break;
    attemptedTailCounts.push(tailCount);

    const candidate = buildKiroHistoryCandidate(originalHistory, keepHead, tailCount);
    state.history = candidate.history;
    setCurrentMessageNotice(state, originalContent, candidate.omittedCount, candidate.headCount, candidate.tailCount);

    const afterBytes = estimatePayloadBytes(body);
    const afterTokens = Math.ceil(afterBytes / CHARS_PER_TOKEN_ESTIMATE);
    best = { ...candidate, afterBytes, afterTokens };
    if (afterTokens <= limitTokens) {
      return {
        applied: true,
        tooLarge: false,
        provider: "kiro",
        beforeBytes,
        afterBytes,
        beforeTokens,
        afterTokens,
        limitTokens,
        omittedCount: candidate.omittedCount,
        keptHistoryCount: candidate.history.length,
      };
    }
  }

  return {
    applied: true,
    tooLarge: true,
    provider: "kiro",
    beforeBytes,
    afterBytes: best?.afterBytes || estimatePayloadBytes(body),
    beforeTokens,
    afterTokens: best?.afterTokens || estimatePayloadTokens(body),
    limitTokens,
    omittedCount: best?.omittedCount || 0,
    keptHistoryCount: best?.history?.length || 0,
  };
}

export function applyAutoCompact({ provider, body, options = {} }) {
  if (provider === "kiro") return compactKiroPayload(body, options);
  return null;
}

