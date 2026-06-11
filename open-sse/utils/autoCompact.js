const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_KIRO_AUTO_COMPACT_LIMIT_TOKENS = 150_000;
const DEFAULT_KIRO_KEEP_TAIL = 24;
const MIN_KIRO_KEEP_TAIL = 4;
const AUTO_COMPACT_MARKER = "[9router auto-compact]";
const TOOL_RESULT_OMITTED_NOTICE = "[Tool result metadata omitted during 9router auto-compact because the matching tool call was no longer in retained history.]";
const MAX_PRESERVED_REFERENCES = 32;
const MAX_REFERENCE_CHARS = 320;
const MAX_REFERENCE_SECTION_CHARS = 6000;
const REFERENCE_KEY_PATTERN = /(path|url|uri|file|href|link|source)/i;
const URL_PATTERN = /\b(?:https?|file):\/\/[^\s<>"'`]+/gi;
const UNIX_PATH_PATTERN = /(?:^|[\s"'`({\[])(\/(?:Users|var|tmp|private|Volumes|Applications|opt|usr|etc|home|mnt|workspace|root)\/[^\s<>"'`]+)/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s<>"'`]+/g;

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

function cloneJson(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function trimReference(value) {
  return String(value || "")
    .trim()
    .replace(/^[<([{\"'`]+/, "")
    .replace(/[.,;:!?)}\]>\"'`]+$/g, "")
    .slice(0, MAX_REFERENCE_CHARS);
}

function addReference(refs, seenRefs, value) {
  if (refs.length >= MAX_PRESERVED_REFERENCES) return;
  const ref = trimReference(value);
  if (!ref || seenRefs.has(ref)) return;
  seenRefs.add(ref);
  refs.push(ref);
}

function collectReferencesFromText(text, refs, seenRefs) {
  if (!text || refs.length >= MAX_PRESERVED_REFERENCES) return;

  URL_PATTERN.lastIndex = 0;
  for (let match = URL_PATTERN.exec(text); match; match = URL_PATTERN.exec(text)) {
    addReference(refs, seenRefs, match[0]);
  }

  UNIX_PATH_PATTERN.lastIndex = 0;
  for (let match = UNIX_PATH_PATTERN.exec(text); match; match = UNIX_PATH_PATTERN.exec(text)) {
    addReference(refs, seenRefs, match[1] || match[0]);
  }

  WINDOWS_PATH_PATTERN.lastIndex = 0;
  for (let match = WINDOWS_PATH_PATTERN.exec(text); match; match = WINDOWS_PATH_PATTERN.exec(text)) {
    addReference(refs, seenRefs, match[0]);
  }
}

function collectProtectedReferences(value, refs = [], seenRefs = new Set(), seenObjects = new WeakSet(), depth = 0) {
  if (refs.length >= MAX_PRESERVED_REFERENCES || depth > 8 || value == null) return refs;

  if (typeof value === "string") {
    collectReferencesFromText(value, refs, seenRefs);
    return refs;
  }

  if (typeof value !== "object") return refs;
  if (seenObjects.has(value)) return refs;
  seenObjects.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectProtectedReferences(item, refs, seenRefs, seenObjects, depth + 1);
    return refs;
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && REFERENCE_KEY_PATTERN.test(key)) {
      addReference(refs, seenRefs, child);
    }
    collectProtectedReferences(child, refs, seenRefs, seenObjects, depth + 1);
  }
  return refs;
}

function buildProtectedReferenceNotice(references) {
  if (!Array.isArray(references) || references.length === 0) return "";
  const lines = [];
  let totalChars = 0;
  for (let i = 0; i < references.length; i++) {
    const line = `- ${references[i]}`;
    if (totalChars + line.length > MAX_REFERENCE_SECTION_CHARS) {
      lines.push(`- ... ${references.length - i} more references omitted`);
      break;
    }
    lines.push(line);
    totalChars += line.length;
  }
  return `\n\nPreserved references from omitted history:\n${lines.join("\n")}`;
}

function isAutoCompactEnabled(options = {}) {
  return options.enabled === true || options.policy === "auto" || options.policy === "auto-before-fallback";
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

function setCurrentMessageNotice(state, originalContent, omittedCount, headCount, tailCount, protectedReferences = []) {
  const userInput = state?.currentMessage?.userInputMessage;
  if (!userInput) return false;
  const referenceNotice = buildProtectedReferenceNotice(protectedReferences);
  const notice = `${AUTO_COMPACT_MARKER} Earlier Kiro history was shortened before upstream dispatch because this session exceeded the provider content-length threshold. Omitted ${omittedCount} older history entries; kept ${headCount} initial and ${tailCount} recent entries.${referenceNotice}`;
  const currentContent = typeof userInput.content === "string" ? userInput.content : String(userInput.content || "");
  userInput.content = `${notice}\n\n${currentContent || originalContent || "continue"}`;
  return true;
}

function buildKiroHistoryCandidate(history, keepTail, currentMessage) {
  const tailStart = keepTail > 0 ? Math.max(0, history.length - keepTail) : history.length;
  const omittedHistory = history.slice(0, tailStart);
  const tail = keepTail > 0 ? history.slice(tailStart).map(cloneJson) : [];
  const protectedReferences = collectProtectedReferences(omittedHistory);
  const candidateHistory = normalizeKiroHistorySuffix(tail, currentMessage);
  const omittedCount = Math.max(0, history.length - tail.length);
  return {
    history: candidateHistory,
    omittedCount,
    headCount: 0,
    tailCount: candidateHistory.length,
    protectedReferences,
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
  const originalCurrentMessage = cloneJson(state.currentMessage);
  const initialTail = options.keepTail ?? readPositiveIntEnv("KIRO_AUTO_COMPACT_KEEP_TAIL", DEFAULT_KIRO_KEEP_TAIL);
  const minTail = options.minTail ?? MIN_KIRO_KEEP_TAIL;

  let best = null;
  const attemptedTailCounts = [];
  for (let tailCount = Math.min(initialTail, originalHistory.length); tailCount >= minTail; tailCount = Math.floor(tailCount * 0.7)) {
    if (attemptedTailCounts.includes(tailCount)) break;
    attemptedTailCounts.push(tailCount);

    state.currentMessage = cloneJson(originalCurrentMessage);
    state.currentMessage.userInputMessage.content = originalContent;
    const candidate = buildKiroHistoryCandidate(originalHistory, tailCount, state.currentMessage);
    state.history = candidate.history;
    setCurrentMessageNotice(state, originalContent, candidate.omittedCount, candidate.headCount, candidate.tailCount, candidate.protectedReferences);

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
  if (provider === "kiro") {
    if (!isAutoCompactEnabled(options)) {
      const limitTokens = options.limitTokens || getProviderAutoCompactLimit(provider);
      const beforeBytes = estimatePayloadBytes(body);
      const beforeTokens = Math.ceil(beforeBytes / CHARS_PER_TOKEN_ESTIMATE);
      return {
        applied: false,
        disabled: true,
        tooLarge: !!(limitTokens && beforeTokens > limitTokens),
        provider,
        beforeBytes,
        afterBytes: beforeBytes,
        beforeTokens,
        afterTokens: beforeTokens,
        limitTokens,
      };
    }
    return compactKiroPayload(body, options);
  }
  return null;
}
