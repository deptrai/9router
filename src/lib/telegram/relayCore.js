/**
 * relayCore.js — bounded Telegram interaction runner (Story 2-38, course correction).
 *
 * Shared by `scripts/telegram-relay.js` (HTTP bootstrap) and the
 * `telegram_bot_scraper` adapter's `validate()`, so step/collect bounds are defined in
 * exactly one place.
 */

const MAX_STEPS = 10;
const MAX_TEXT_LENGTH = 4096;
// A `contains` match on a very short target is dangerous: it can match an unintended
// button (supplier shop bots carry buy/confirm buttons whose press is billable and not
// reversible). Short targets must be `exact` (code review 2026-07-28, D5).
const MIN_CONTAINS_LENGTH = 8;
// Overall ceiling for one interaction, independent of how many steps were configured.
// Each phase gets its own `collect.timeoutMs` window, but the whole flow can never run
// longer than this.
const MAX_FLOW_TIMEOUT_MS = 120_000;
// Telegram username rules: 5-32 chars, must start with a letter, letters/digits/underscore
// only. Enforced so `botUsername` cannot be a phone number, `me`, or a t.me link — the
// relay resolves this value with getEntity() and would happily message a real user.
const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const DEFAULT_COLLECT = Object.freeze({
  timeoutMs: 30_000,
  idleMs: 1_500,
  maxMessages: 20,
});
const COLLECT_BOUNDS = Object.freeze({
  timeoutMs: { min: 100, max: 60_000 },
  idleMs: { min: 10, max: 10_000 },
  maxMessages: { min: 1, max: 50 },
});
const STEP_KEYS = new Set(["action", "text", "match", "collect"]);
const COLLECT_KEYS = new Set(["timeoutMs", "idleMs", "maxMessages"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, name, bounds, fallback) {
  if (value === undefined) return { ok: true, value: fallback };
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return {
      ok: false,
      error: `collect.${name} must be an integer between ${bounds.min} and ${bounds.max}`,
    };
  }
  return { ok: true, value };
}

export function normalizeButtonText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    // toLowerCase(), NOT toLocaleLowerCase(): without an explicit locale the latter uses
    // the host locale, and on a tr/az host "I" folds to "ı" so "KIRO" stops matching
    // "kiro" — a bug that only appears on certain deploy environments.
    .toLowerCase();
}

export function validateRelayRequest(request) {
  if (!isPlainObject(request)) {
    return { ok: false, error: "request body must be an object" };
  }

  const rawBotUsername = typeof request.botUsername === "string" ? request.botUsername.trim() : "";
  const botUsername = rawBotUsername.replace(/^@+/, "");
  if (!BOT_USERNAME_RE.test(botUsername)) {
    return {
      ok: false,
      error: "botUsername must be a Telegram username: 5-32 chars, starting with a letter, only letters/digits/underscore",
    };
  }

  let rawSteps;
  if (request.steps !== undefined) {
    if (!Array.isArray(request.steps) || request.steps.length < 1 || request.steps.length > MAX_STEPS) {
      return { ok: false, error: `steps must contain between 1 and ${MAX_STEPS} items` };
    }
    rawSteps = request.steps;
  } else {
    const command = typeof request.command === "string" ? request.command.trim() : "";
    if (!command) {
      return { ok: false, error: "command or steps is required" };
    }
    rawSteps = [{ action: "send", text: command }];
  }

  const steps = [];
  let collectMarkers = 0;
  for (let index = 0; index < rawSteps.length; index += 1) {
    const step = rawSteps[index];
    if (!isPlainObject(step)) {
      return { ok: false, error: `steps[${index}] must be an object` };
    }
    const unknownKey = Object.keys(step).find((key) => !STEP_KEYS.has(key));
    if (unknownKey) {
      return { ok: false, error: `steps[${index}].${unknownKey} is not supported` };
    }
    if (step.action !== "send" && step.action !== "press") {
      return { ok: false, error: `steps[${index}].action must be send or press` };
    }
    if (typeof step.text !== "string" || !step.text.trim() || step.text.length > MAX_TEXT_LENGTH) {
      return {
        ok: false,
        error: `steps[${index}].text is required and must not exceed ${MAX_TEXT_LENGTH} characters`,
      };
    }
    const match = step.match ?? "exact";
    if (match !== "exact" && match !== "contains") {
      return { ok: false, error: `steps[${index}].match must be exact or contains` };
    }
    if (match === "contains" && normalizeButtonText(step.text).length < MIN_CONTAINS_LENGTH) {
      return {
        ok: false,
        error: `steps[${index}].match must be exact when text is shorter than ${MIN_CONTAINS_LENGTH} normalized characters (a short "contains" target can press an unintended button)`,
      };
    }
    if (step.collect !== undefined && typeof step.collect !== "boolean") {
      return { ok: false, error: `steps[${index}].collect must be a boolean` };
    }
    if (step.collect) collectMarkers += 1;

    steps.push({
      action: step.action,
      text: step.text.trim(),
      match,
      collect: step.collect === true,
    });
  }

  if (collectMarkers > 1) {
    return { ok: false, error: "only one step may set collect=true" };
  }

  if (request.collect !== undefined && !isPlainObject(request.collect)) {
    return { ok: false, error: "collect must be an object" };
  }
  const rawCollect = request.collect ?? {};
  const unknownCollectKey = Object.keys(rawCollect).find((key) => !COLLECT_KEYS.has(key));
  if (unknownCollectKey) {
    return { ok: false, error: `collect.${unknownCollectKey} is not supported` };
  }

  const timeout = boundedInteger(
    rawCollect.timeoutMs,
    "timeoutMs",
    COLLECT_BOUNDS.timeoutMs,
    DEFAULT_COLLECT.timeoutMs,
  );
  if (!timeout.ok) return timeout;
  const idle = boundedInteger(
    rawCollect.idleMs,
    "idleMs",
    COLLECT_BOUNDS.idleMs,
    DEFAULT_COLLECT.idleMs,
  );
  if (!idle.ok) return idle;
  const maxMessages = boundedInteger(
    rawCollect.maxMessages,
    "maxMessages",
    COLLECT_BOUNDS.maxMessages,
    DEFAULT_COLLECT.maxMessages,
  );
  if (!maxMessages.ok) return maxMessages;
  if (idle.value > timeout.value) {
    return { ok: false, error: "collect.idleMs must not exceed collect.timeoutMs" };
  }

  return {
    ok: true,
    value: {
      botUsername,
      steps,
      collect: {
        timeoutMs: timeout.value,
        idleMs: idle.value,
        maxMessages: maxMessages.value,
      },
    },
  };
}

/**
 * Worst-case wall time one `runInteraction` can consume, so a caller can size its own
 * HTTP timeout above the relay's rather than aborting first and masking the real error.
 */
export function flowTimeoutMs(flow) {
  const phases = (flow?.steps?.length ?? 1) + 1;
  return Math.min((flow?.collect?.timeoutMs ?? DEFAULT_COLLECT.timeoutMs) * phases, MAX_FLOW_TIMEOUT_MS);
}

function messageId(message) {
  const id = Number(message?.id ?? 0);
  return Number.isFinite(id) ? id : 0;
}

function latestMessageId(messages) {
  return messages.reduce((latest, message) => Math.max(latest, messageId(message)), 0);
}

async function readMessages(client, entity, limit = 50) {
  const messages = await client.getMessages(entity, { limit });
  return Array.isArray(messages) ? messages : Array.from(messages ?? []);
}

function isIncomingTextMessage(message) {
  return message?.out !== true
    && typeof message?.message === "string"
    && message.message.trim().length > 0;
}

// Real Telegram bots often respond to an inline callback button by EDITING the same
// message in place (same id, new text) rather than sending a new message — confirmed via
// manual E2E against @tainguyenvibebot on 2026-07-28 (pressing an inline "⚡ TÀI KHOẢN
// KIRO" button rewrote the category message into the product catalog, no new message
// id was created). An id-only boundary misses this entirely. A content snapshot
// (id -> text) lets us detect BOTH a brand-new message id AND an existing id whose text
// changed.
export function snapshotMessages(messages) {
  const snapshot = new Map();
  for (const message of messages ?? []) {
    if (!isIncomingTextMessage(message)) continue;
    snapshot.set(messageId(message), message.message);
  }
  return snapshot;
}

export function diffChangedMessages(messages, snapshot, maxMessages = 20) {
  const baseline = snapshot ?? new Map();
  const changed = [];
  for (const message of messages ?? []) {
    if (!isIncomingTextMessage(message)) continue;
    const id = messageId(message);
    if (!baseline.has(id) || baseline.get(id) !== message.message) {
      changed.push({ id, text: message.message });
    }
  }
  return changed
    .sort((left, right) => left.id - right.id)
    .slice(0, maxMessages);
}

async function getMessageButtons(message) {
  if (typeof message?.getButtons === "function") {
    return await message.getButtons();
  }
  return message?.buttons ?? [];
}

function matchesButton(buttonText, targetText, match) {
  const normalizedButton = normalizeButtonText(buttonText);
  const normalizedTarget = normalizeButtonText(targetText);
  if (!normalizedButton || !normalizedTarget) return false;
  return match === "contains"
    ? normalizedButton.includes(normalizedTarget)
    : normalizedButton === normalizedTarget;
}

/**
 * Press a matching button, searching the most recent message first.
 *
 * Candidates are restricted to `minMessageId` and above — i.e. messages produced during
 * THIS flow. The search is deliberately not pinned to a single message (a button can live
 * on an earlier message of the same flow that a later press edits in place, per the
 * @tainguyenvibebot E2E), but it must not reach into pre-flow chat history: on a supplier
 * shop bot, pressing a stale buy/confirm button is a billable, non-reversible action
 * (code review 2026-07-28, D5).
 */
export async function pressButton(messages, step, { minMessageId = 0 } = {}) {
  const candidates = [...(messages ?? [])]
    .filter((message) => message?.out !== true && messageId(message) >= minMessageId)
    .sort((left, right) => messageId(right) - messageId(left));

  for (const message of candidates) {
    const rows = await getMessageButtons(message);
    const buttons = Array.isArray(rows) ? rows.flat() : [];
    const button = buttons.find((candidate) => (
      typeof candidate?.click === "function"
      && matchesButton(candidate.text, step.text, step.match ?? "exact")
    ));
    if (!button) continue;

    // GramJS MessageButton.click() destructures its argument ({ sharePhone, shareGeo,
    // password }) — calling it with no argument throws on destructuring `undefined`.
    // Passing {} is required even though we never need sharePhone/shareGeo/password here.
    const result = await button.click({});
    return {
      buttonText: button.text,
      messageId: messageId(message),
      result,
    };
  }

  throw new Error(`missing button "${step.text}"`);
}

/**
 * Deadline for one phase (a single step, or the collect phase): its own
 * `collect.timeoutMs` window, clamped by the overall flow deadline.
 *
 * Previously a single deadline derived from `collect.timeoutMs` covered every step AND the
 * collect phase, so early steps consumed the whole budget, the collect loop ran zero
 * iterations, and the failure was always misattributed to the final step.
 */
function phaseDeadline(runtime) {
  return Math.min(runtime.now() + runtime.phaseTimeoutMs, runtime.flowDeadline);
}

// Wait until at least one incoming message changed (new id, or existing id with new
// text — see snapshotMessages/diffChangedMessages) relative to `snapshot`.
async function waitForChange(client, entity, snapshot, runtime) {
  const deadline = phaseDeadline(runtime);
  while (runtime.now() <= deadline) {
    const messages = await readMessages(client, entity, runtime.readLimit);
    if (diffChangedMessages(messages, snapshot, 1).length > 0) return;
    if (runtime.now() >= deadline) break;
    await runtime.sleep(runtime.pollIntervalMs);
  }
  throw new Error("timed out waiting for bot response");
}

// Poll for a matching button, click it as soon as found, and return a content snapshot
// taken immediately BEFORE the click — the caller diffs against this snapshot to detect
// the bot's response, whether it arrives as a new message or an edit of an existing one.
async function waitAndPressButton(client, entity, step, runtime) {
  const deadline = phaseDeadline(runtime);
  while (runtime.now() <= deadline) {
    const messages = await readMessages(client, entity, runtime.readLimit);
    const preActionSnapshot = snapshotMessages(messages);
    try {
      const pressed = await pressButton(messages, step, { minMessageId: runtime.minMessageId });
      return { pressed, preActionSnapshot };
    } catch (error) {
      if (!String(error?.message ?? "").startsWith("missing button")) throw error;
    }
    if (runtime.now() >= deadline) break;
    await runtime.sleep(runtime.pollIntervalMs);
  }
  throw new Error(`missing button "${step.text}" before timeout`);
}

// Collect incoming text content that changed relative to `snapshot` — catches both
// brand-new messages and messages edited in place (id unchanged, text changed).
async function collectChangedMessages(client, entity, snapshot, collect, runtime) {
  const deadline = phaseDeadline(runtime);
  const collected = new Map();
  let lastNewAt = null;

  while (runtime.now() <= deadline) {
    const messages = await readMessages(client, entity, runtime.readLimit);
    const changed = diffChangedMessages(messages, snapshot, collect.maxMessages);
    let added = false;
    for (const message of changed) {
      if (collected.size >= collect.maxMessages && !collected.has(message.id)) break;
      if (collected.get(message.id) !== message.text) {
        collected.set(message.id, message.text);
        added = true;
      }
    }
    if (added) lastNewAt = runtime.now();
    if (collected.size >= collect.maxMessages) break;
    // runtime.idleMs is clamped to at least one poll interval — an idleMs below the poll
    // interval would always be "exceeded" after the first sleep, truncating a catalog the
    // bot sends as several consecutive messages.
    if (lastNewAt !== null && runtime.now() - lastNewAt >= runtime.idleMs) break;
    if (runtime.now() >= deadline) break;
    await runtime.sleep(runtime.pollIntervalMs);
  }

  return [...collected.entries()]
    .sort(([leftId], [rightId]) => leftId - rightId)
    .map(([id, text]) => ({ id, text }));
}

export async function runInteraction(client, entity, request, options = {}) {
  const validation = validateRelayRequest(request);
  if (!validation.ok) throw new Error(validation.error);
  const flow = validation.value;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Upper bound raised to 5s (was 1s) — MTProto messages.GetHistory is rate-limited by
  // Telegram (FLOOD_WAIT) when polled too frequently against a real bot; unit tests use a
  // fake clock so this only affects real relay runs (RELAY_POLL_MS env).
  const pollIntervalMs = Math.max(10, Math.min(Number(options.pollIntervalMs) || 250, 5_000));
  const runtime = {
    now,
    sleep,
    pollIntervalMs,
    phaseTimeoutMs: flow.collect.timeoutMs,
    flowDeadline: now() + flowTimeoutMs(flow),
    // At least two poll intervals: the idle window is wall-clock, so it has to span more
    // than a single poll to mean anything. With the raw value (idleMs 10 vs a 250ms poll)
    // the very first silent poll ended collection, truncating a catalog the bot sends as
    // several consecutive messages down to its first batch.
    idleMs: Math.max(flow.collect.idleMs, pollIntervalMs * 2),
    readLimit: Math.min(50, Math.max(flow.collect.maxMessages + flow.steps.length * 2, 20)),
    minMessageId: 0,
  };

  const baselineMessages = await readMessages(client, entity, runtime.readLimit);
  const baselineId = latestMessageId(baselineMessages);
  const baselineSnapshot = snapshotMessages(baselineMessages);
  // Only buttons on messages from this flow onward are pressable (D5). `baselineId` is the
  // newest pre-flow message, so anything at or above it belongs to the flow — the bot's
  // reply to our first step lands above it.
  runtime.minMessageId = baselineId;

  let lastActionSnapshot = baselineSnapshot;
  let collectionSnapshot = null;
  const hasExplicitCollectBoundary = flow.steps.some((step) => step.collect);

  for (let index = 0; index < flow.steps.length; index += 1) {
    const step = flow.steps[index];
    const isFinalStep = index === flow.steps.length - 1;
    const startsCollection = step.collect || (!hasExplicitCollectBoundary && isFinalStep);

    try {
      if (step.action === "send") {
        if (index > 0) {
          await waitForChange(client, entity, lastActionSnapshot, runtime);
        }
        const messages = await readMessages(client, entity, runtime.readLimit);
        const preActionSnapshot = snapshotMessages(messages);
        if (startsCollection) collectionSnapshot = preActionSnapshot;
        await client.sendMessage(entity, { message: step.text });
        lastActionSnapshot = preActionSnapshot;
      } else {
        const { preActionSnapshot } = await waitAndPressButton(client, entity, step, runtime);
        if (startsCollection) collectionSnapshot = preActionSnapshot;
        lastActionSnapshot = preActionSnapshot;
      }
    } catch (error) {
      throw new Error(`Step ${index + 1} (${step.action}) failed: ${error.message}`);
    }
  }

  const finalSnapshot = collectionSnapshot ?? baselineSnapshot;
  const collected = await collectChangedMessages(client, entity, finalSnapshot, flow.collect, runtime);
  if (collected.length === 0) {
    // Attributed to the collect phase, not to the last step: every step already completed
    // successfully to get here, so blaming the step sends debugging the wrong way.
    throw new Error(
      `Collect phase failed: timed out waiting for bot response after step ${flow.steps.length} (${flow.steps[flow.steps.length - 1].action})`,
    );
  }

  return {
    baselineId,
    messageIds: collected.map((message) => message.id),
    messages: collected.map((message) => message.text),
  };
}
