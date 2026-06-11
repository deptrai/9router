const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_KIRO_AUTO_COMPACT_LIMIT_TOKENS = 150_000;
const DEFAULT_KIRO_KEEP_TAIL = 24;
const MIN_KIRO_KEEP_TAIL = 4;
const AUTO_COMPACT_MARKER = "[9router auto-compact]";
const TOOL_RESULT_OMITTED_NOTICE = "[Tool result metadata omitted during 9router auto-compact because the matching tool call was no longer in retained history.]";

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

function getUserInput(item) {
  return item?.userInputMessage || null;
}

function getAssistantResponse(item) {
  return item?.assistantResponseMessage || null;
}

function getToolResults(item) {
  const results = getUserInput(item)?.userInputMessageContext?.toolResults;
  return Array.isArray(results) ? results : [];
}

function getToolUses(item) {
  const uses = getAssistantResponse(item)?.toolUses;
  return Array.isArray(uses) ? uses : [];
}

function cleanupUserContext(item) {
  const context = getUserInput(item)?.userInputMessageContext;
  if (context && Object.keys(context).length === 0) {
    delete item.userInputMessage.userInputMessageContext;
  }
}

function appendToolResultsAsText(item, results) {
  const userInput = getUserInput(item);
  if (!userInput || results.length === 0) return;

  const text = results
    .map((result) => {
      const content = Array.isArray(result?.content)
        ? result.content.map((part) => part?.text || "").filter(Boolean).join("\n")
        : "";
      return content ? `tool_result ${result.toolUseId || "unknown"}:\n${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  userInput.content = [userInput.content || "", TOOL_RESULT_OMITTED_NOTICE, text]
    .filter(Boolean)
    .join("\n\n");
}

function mergeKiroItems(target, source, kind) {
  if (kind === "user") {
    appendContent(target, source, "userInputMessage");
    const sourceContext = getUserInput(source)?.userInputMessageContext;
    if (!sourceContext) return;
    const targetInput = getUserInput(target);
    targetInput.userInputMessageContext ||= {};
    if (Array.isArray(sourceContext.toolResults)) {
      targetInput.userInputMessageContext.toolResults = [
        ...(targetInput.userInputMessageContext.toolResults || []),
        ...sourceContext.toolResults,
      ];
    }
    if (Array.isArray(sourceContext.tools) && !targetInput.userInputMessageContext.tools) {
      targetInput.userInputMessageContext.tools = sourceContext.tools;
    }
    return;
  }

  appendContent(target, source, "assistantResponseMessage");
  const sourceToolUses = getToolUses(source);
  if (sourceToolUses.length > 0) {
    const targetResponse = getAssistantResponse(target);
    targetResponse.toolUses = [
      ...(targetResponse.toolUses || []),
      ...sourceToolUses,
    ];
  }
}

function mergeAdjacentKiroHistory(history) {
  const merged = [];
  for (const item of history) {
    const kind = getKiroMessageKind(item);
    const last = merged[merged.length - 1];
    if (kind && getKiroMessageKind(last) === kind) {
      mergeKiroItems(last, item, kind);
      continue;
    }
    merged.push(item);
  }
  return merged;
}

function sanitizeKiroToolContext(history, currentMessage) {
  const sequence = [...history, currentMessage].filter(Boolean);

  for (let i = 0; i < sequence.length; i++) {
    const item = sequence[i];
    const kind = getKiroMessageKind(item);

    if (kind === "user") {
      const results = getToolResults(item);
      if (results.length === 0) continue;

      const prev = sequence[i - 1];
      const prevUseIds = new Set(getToolUses(prev).map((use) => use?.toolUseId).filter(Boolean));
      const validResults = results.filter((result) => result?.toolUseId && prevUseIds.has(result.toolUseId));
      if (validResults.length === results.length) continue;

      if (item === currentMessage) appendToolResultsAsText(item, results.filter((result) => !validResults.includes(result)));

      const context = item.userInputMessage.userInputMessageContext;
      if (validResults.length > 0) context.toolResults = validResults;
      else delete context.toolResults;
      cleanupUserContext(item);
    }
  }

  for (let i = 0; i < sequence.length; i++) {
    const item = sequence[i];
    if (getKiroMessageKind(item) !== "assistant") continue;

    const uses = getToolUses(item);
    if (uses.length === 0) continue;

    const next = sequence[i + 1];
    const nextResultIds = new Set(getToolResults(next).map((result) => result?.toolUseId).filter(Boolean));
    const validUses = uses.filter((use) => use?.toolUseId && nextResultIds.has(use.toolUseId));
    if (validUses.length === uses.length) continue;

    if (validUses.length > 0) item.assistantResponseMessage.toolUses = validUses;
    else delete item.assistantResponseMessage.toolUses;
  }
}

function normalizeKiroHistorySuffix(history, currentMessage) {
  const knownItems = history.filter((item) => getKiroMessageKind(item));
  while (knownItems.length > 0 && getKiroMessageKind(knownItems[0]) !== "user") {
    knownItems.shift();
  }

  const merged = mergeAdjacentKiroHistory(knownItems);
  sanitizeKiroToolContext(merged, currentMessage);
  return merged;
}

function setCurrentMessageNotice(state, originalContent, omittedCount, headCount, tailCount) {
  const userInput = state?.currentMessage?.userInputMessage;
  if (!userInput) return false;
  const notice = `${AUTO_COMPACT_MARKER} Earlier Kiro history was shortened before upstream dispatch because this session exceeded the provider content-length threshold. Omitted ${omittedCount} older history entries; kept ${headCount} initial and ${tailCount} recent entries.`;
  const currentContent = typeof userInput.content === "string" ? userInput.content : String(userInput.content || "");
  userInput.content = `${notice}\n\n${currentContent || originalContent || "continue"}`;
  return true;
}

function buildKiroHistoryCandidate(history, keepTail, currentMessage) {
  const tail = keepTail > 0 ? history.slice(Math.max(0, history.length - keepTail)) : [];
  const candidateHistory = normalizeKiroHistorySuffix(tail, currentMessage);
  const omittedCount = Math.max(0, history.length - tail.length);
  return {
    history: candidateHistory,
    omittedCount,
    headCount: 0,
    tailCount: candidateHistory.length,
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
  const initialTail = options.keepTail ?? readPositiveIntEnv("KIRO_AUTO_COMPACT_KEEP_TAIL", DEFAULT_KIRO_KEEP_TAIL);
  const minTail = options.minTail ?? MIN_KIRO_KEEP_TAIL;

  let best = null;
  const attemptedTailCounts = [];
  for (let tailCount = Math.min(initialTail, originalHistory.length); tailCount >= minTail; tailCount = Math.floor(tailCount * 0.7)) {
    if (attemptedTailCounts.includes(tailCount)) break;
    attemptedTailCounts.push(tailCount);

    state.currentMessage.userInputMessage.content = originalContent;
    const candidate = buildKiroHistoryCandidate(originalHistory, tailCount, state.currentMessage);
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
