/**
 * relay-core.js — Bounded Telegram interaction runner for single-session relay.
 *
 * Enforces exact match only for button presses and prevents clicking any
 * payment/purchase buttons via BLOCKED_BUTTON_KEYWORDS.
 */

export const BLOCKED_BUTTON_KEYWORDS = Object.freeze([
  "mua",
  "buy",
  "thanh toán",
  "order",
  "nạp",
  "pay",
  "xác nhận",
  "confirm",
  "chuyển tiền",
]);

const MAX_STEPS = 10;
const MAX_TEXT_LENGTH = 4096;
const MAX_FLOW_TIMEOUT_MS = 120_000;
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

    if (step.match !== undefined && step.match !== "exact") {
      return { ok: false, error: `steps[${index}].match must be exact` };
    }
    const match = "exact";

    const normalizedStepText = normalizeButtonText(step.text);
    const stepBlocked = BLOCKED_BUTTON_KEYWORDS.find((kw) =>
      normalizedStepText.includes(normalizeButtonText(kw))
    );
    if (stepBlocked) {
      return { ok: false, error: `steps[${index}].text blocked payment keyword: "${stepBlocked}"` };
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
  const idleFallback = Math.min(DEFAULT_COLLECT.idleMs, timeout.value);
  const idle = boundedInteger(
    rawCollect.idleMs,
    "idleMs",
    COLLECT_BOUNDS.idleMs,
    idleFallback,
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
  const includeButtons = request.includeButtons === true;

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
      includeButtons,
    },
  };
}

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

function matchesButton(buttonText, targetText) {
  const normalizedButton = normalizeButtonText(buttonText);
  const normalizedTarget = normalizeButtonText(targetText);
  if (!normalizedButton || !normalizedTarget) return false;
  return normalizedButton === normalizedTarget;
}

export async function pressButton(messages, step, { minMessageId = 0 } = {}) {
  const normalizedStepText = normalizeButtonText(step?.text);
  const stepBlocked = BLOCKED_BUTTON_KEYWORDS.find((kw) =>
    normalizedStepText.includes(normalizeButtonText(kw))
  );
  if (stepBlocked) {
    throw new Error(`blocked payment keyword in button: "${step.text}"`);
  }

  const candidates = [...(messages ?? [])]
    .filter((message) => message?.out !== true && messageId(message) > minMessageId)
    .sort((left, right) => messageId(right) - messageId(left));

  for (const message of candidates) {
    const rows = await getMessageButtons(message);
    const buttons = Array.isArray(rows) ? rows.flat() : [];
    const button = buttons.find((candidate) => (
      typeof candidate?.click === "function"
      && matchesButton(candidate.text, step.text)
    ));
    if (!button) continue;

    const normalizedButtonText = normalizeButtonText(button.text);
    const candidateBlocked = BLOCKED_BUTTON_KEYWORDS.find((kw) =>
      normalizedButtonText.includes(normalizeButtonText(kw))
    );
    if (candidateBlocked) {
      throw new Error(`blocked payment keyword in button: "${button.text}"`);
    }

    const result = await button.click({});
    return {
      buttonText: button.text,
      messageId: messageId(message),
      result,
    };
  }

  throw new Error(`missing button "${step.text}"`);
}

function phaseDeadline(runtime) {
  return Math.min(runtime.now() + runtime.phaseTimeoutMs, runtime.flowDeadline);
}

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

async function waitAndPressButton(client, entity, step, runtime) {
  const deadline = phaseDeadline(runtime);
  while (runtime.now() <= deadline) {
    const messages = await readMessages(client, entity, runtime.readLimit);
    const preActionSnapshot = snapshotMessages(messages);
    try {
      const pressed = await pressButton(messages, step, { minMessageId: runtime.minMessageId });
      return { pressed, preActionSnapshot };
    } catch (error) {
      const err = /** @type {any} */ (error);
      if (!String(err?.message ?? "").startsWith("missing button")) throw error;
    }
    if (runtime.now() >= deadline) break;
    await runtime.sleep(runtime.pollIntervalMs);
  }
  throw new Error(`missing button "${step.text}" before timeout`);
}

export async function collectChangedMessages(client, entity, snapshot, collect, runtime) {
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
    if (lastNewAt !== null && runtime.now() - lastNewAt >= runtime.idleMs) break;
    if (runtime.now() >= deadline) break;
    await runtime.sleep(runtime.pollIntervalMs);
  }

  return [...collected.entries()]
    .sort(([leftId], [rightId]) => leftId - rightId)
    .map(([id, text]) => ({ id, text }));
}

export async function getLatestMessageButtons(client, entity, minMessageId, limit = 20) {
  const messages = await readMessages(client, entity, limit);
  const candidates = [...(messages ?? [])]
    .filter((message) => message?.out !== true && messageId(message) > minMessageId)
    .sort((left, right) => messageId(right) - messageId(left));
  for (const message of candidates) {
    const rows = await getMessageButtons(message);
    if (rows && rows.length) {
      return rows.flat().map((button) => ({
        text: typeof button.text === "string" ? button.text : String(button.text ?? ""),
      }));
    }
  }
  return [];
}

export async function runInteraction(client, entity, request, options = {}) {
  const validation = validateRelayRequest(request);
  if (!validation.ok) throw new Error(validation.error);
  const flow = validation.value;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = Math.max(10, Math.min(Number(options.pollIntervalMs) || 3000, 5_000));
  const runtime = {
    now,
    sleep,
    pollIntervalMs,
    phaseTimeoutMs: flow.collect.timeoutMs,
    flowDeadline: now() + flowTimeoutMs(flow),
    idleMs: Math.max(flow.collect.idleMs, pollIntervalMs * 2),
    readLimit: Math.min(50, Math.max(flow.collect.maxMessages + flow.steps.length * 2, 20)),
    minMessageId: 0,
  };

  const baselineMessages = await readMessages(client, entity, runtime.readLimit);
  const baselineId = latestMessageId(baselineMessages);
  const baselineSnapshot = snapshotMessages(baselineMessages);
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
      const err = /** @type {any} */ (error);
      throw new Error(`Step ${index + 1} (${step.action}) failed: ${err?.message ?? err}`);
    }
  }

  const finalSnapshot = collectionSnapshot ?? baselineSnapshot;
  const collected = await collectChangedMessages(client, entity, finalSnapshot, flow.collect, runtime);
  if (collected.length === 0) {
    throw new Error(
      `Collect phase failed: timed out waiting for bot response after step ${flow.steps.length} (${flow.steps[flow.steps.length - 1].action})`,
    );
  }

  const result = {
    baselineId,
    messageIds: collected.map((message) => message.id),
    messages: collected.map((message) => message.text),
  };
  if (flow.includeButtons) {
    result.buttons = await getLatestMessageButtons(client, entity, baselineId, runtime.readLimit);
  }
  return result;
}
