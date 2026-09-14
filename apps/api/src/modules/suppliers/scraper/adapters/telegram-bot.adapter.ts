import { Injectable } from '@nestjs/common';
import { ISupplierAdapter, PurchaseResult, SupplierTerminalError, ProductRecord, SupplierSourceRecord } from './supplier-adapter';


export const BLOCKED_BUTTON_KEYWORDS = Object.freeze([
  'mua',
  'buy',
  'thanh toán',
  'order',
  'nạp',
  'pay',
  'xác nhận',
  'confirm',
  'chuyển tiền',
]);

const MAX_STEPS = 10;
const MAX_TEXT_LENGTH = 4096;
export const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

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

const STEP_KEYS = new Set(['action', 'text', 'match', 'collect']);
const COLLECT_KEYS = new Set(['timeoutMs', 'idleMs', 'maxMessages']);

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(
  value: unknown,
  name: string,
  bounds: { min: number; max: number },
  fallback: number
): { ok: boolean; value?: number; error?: string } {
  if (value === undefined) return { ok: true, value: fallback };
  if (!Number.isInteger(value) || (value as number) < bounds.min || (value as number) > bounds.max) {
    return {
      ok: false,
      error: `collect.${name} must be an integer between ${bounds.min} and ${bounds.max}`,
    };
  }
  return { ok: true, value: value as number };
}

export function normalizeButtonText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

export function validateRelayRequest(request: any): { ok: boolean; error?: string; value?: any } {
  if (!isPlainObject(request)) {
    return { ok: false, error: 'request body must be an object' };
  }

  const rawBotUsername = typeof request.botUsername === 'string' ? request.botUsername.trim() : '';
  const botUsername = rawBotUsername.replace(/^@+/, '');
  if (!BOT_USERNAME_RE.test(botUsername)) {
    return {
      ok: false,
      error: 'botUsername must be a Telegram username: 5-32 chars, starting with a letter, only letters/digits/underscore',
    };
  }

  let rawSteps: any[];
  if (request.steps !== undefined) {
    if (!Array.isArray(request.steps) || request.steps.length < 1 || request.steps.length > MAX_STEPS) {
      return { ok: false, error: `steps must contain between 1 and ${MAX_STEPS} items` };
    }
    rawSteps = request.steps;
  } else {
    const command = typeof request.command === 'string' ? request.command.trim() : '';
    if (!command) {
      return { ok: false, error: 'command or steps is required' };
    }
    rawSteps = [{ action: 'send', text: command }];
  }

  const steps: any[] = [];
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
    if (step.action !== 'send' && step.action !== 'press') {
      return { ok: false, error: `steps[${index}].action must be send or press` };
    }
    if (typeof step.text !== 'string' || !step.text.trim() || step.text.length > MAX_TEXT_LENGTH) {
      return {
        ok: false,
        error: `steps[${index}].text is required and must not exceed ${MAX_TEXT_LENGTH} characters`,
      };
    }

    if (step.match !== undefined && step.match !== 'exact') {
      return { ok: false, error: `steps[${index}].match must be exact` };
    }
    const match = 'exact';

    const normalizedStepText = normalizeButtonText(step.text);
    // Block only when the step text starts with or exactly matches a payment
    // keyword — avoids false positives on navigation text like
    // "Hướng dẫn mua hàng" (Buying Guide) which merely contains "mua".
    const stepBlocked = BLOCKED_BUTTON_KEYWORDS.find((kw) => {
      const norm = normalizeButtonText(kw);
      return normalizedStepText === norm || normalizedStepText.startsWith(norm);
    });
    if (stepBlocked) {
      return { ok: false, error: `steps[${index}].text blocked payment keyword: "${stepBlocked}"` };
    }

    if (step.collect !== undefined && typeof step.collect !== 'boolean') {
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
    return { ok: false, error: 'only one step may set collect=true' };
  }

  if (request.collect !== undefined && !isPlainObject(request.collect)) {
    return { ok: false, error: 'collect must be an object' };
  }
  const rawCollect = request.collect ?? {};
  const unknownCollectKey = Object.keys(rawCollect).find((key) => !COLLECT_KEYS.has(key));
  if (unknownCollectKey) {
    return { ok: false, error: `collect.${unknownCollectKey} is not supported` };
  }

  const timeout = boundedInteger(
    rawCollect.timeoutMs,
    'timeoutMs',
    COLLECT_BOUNDS.timeoutMs,
    DEFAULT_COLLECT.timeoutMs
  );
  if (!timeout.ok) return timeout;
  const idleFallback = Math.min(DEFAULT_COLLECT.idleMs, timeout.value!);
  const idle = boundedInteger(
    rawCollect.idleMs,
    'idleMs',
    COLLECT_BOUNDS.idleMs,
    idleFallback
  );
  if (!idle.ok) return idle;
  const maxMessages = boundedInteger(
    rawCollect.maxMessages,
    'maxMessages',
    COLLECT_BOUNDS.maxMessages,
    DEFAULT_COLLECT.maxMessages
  );
  if (!maxMessages.ok) return maxMessages;
  if (idle.value! > timeout.value!) {
    return { ok: false, error: 'collect.idleMs must not exceed collect.timeoutMs' };
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

@Injectable()
export class TelegramBotAdapter implements ISupplierAdapter {
  async purchase(_product: ProductRecord, _supplier: SupplierSourceRecord): Promise<PurchaseResult> {
    throw new SupplierTerminalError('MANUAL_FULFILL_REQUIRED');
  }

  validate(configCredentials: unknown): { ok: boolean; reason?: string } {
    if (!isPlainObject(configCredentials)) {
      return { ok: false, reason: 'configCredentials must be an object' };
    }

    const rawBotUsername = typeof configCredentials.botUsername === 'string'
      ? configCredentials.botUsername.trim()
      : '';
    if (!rawBotUsername) {
      return { ok: false, reason: 'botUsername is required' };
    }
    const cleanUsername = rawBotUsername.replace(/^@+/, '');
    if (!BOT_USERNAME_RE.test(cleanUsername)) {
      return {
        ok: false,
        reason: 'botUsername must be a Telegram username: 5-32 chars, starting with a letter, only letters/digits/underscore',
      };
    }

    const rawVnd = configCredentials.vndPerCredit;
    const rate = typeof rawVnd === 'number'
      ? rawVnd
      : typeof rawVnd === 'string' && rawVnd.trim() !== ''
        ? Number(rawVnd)
        : NaN;
    if (!Number.isFinite(rate) || rate <= 0) {
      return { ok: false, reason: 'vndPerCredit is required and must be a number > 0' };
    }

    if (configCredentials.syncIntervalSec !== undefined) {
      const interval = Number(configCredentials.syncIntervalSec);
      if (!Number.isInteger(interval) || interval < 3600) {
        return { ok: false, reason: 'syncIntervalSec must be >= 3600' };
      }
    }

    if (!configCredentials.command && !configCredentials.interactionSteps) {
      return { ok: false, reason: 'command or interactionSteps is required' };
    }

    if (
      'relayUrl' in configCredentials ||
      'relayToken' in configCredentials
    ) {
      return {
        ok: false,
        reason: 'relayUrl and relayToken must not be stored in configCredentials — they resolve strictly from environment variables',
      };
    }

    // SSRF & Security: relayUrl and relayToken must strictly resolve from environment variables
    const relayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL?.trim();
    const relayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN?.trim();
    if (!relayUrl) {
      return { ok: false, reason: 'TELEGRAM_SCRAPER_RELAY_URL environment variable is required' };
    }
    if (!relayToken) {
      return { ok: false, reason: 'TELEGRAM_SCRAPER_RELAY_TOKEN environment variable is required' };
    }

    try {
      const parsedUrl = new URL(relayUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return { ok: false, reason: 'TELEGRAM_SCRAPER_RELAY_URL must use http: or https: protocol' };
      }
    } catch {
      return { ok: false, reason: 'TELEGRAM_SCRAPER_RELAY_URL is not a valid URL' };
    }

    const relayValidation = validateRelayRequest({
      botUsername: cleanUsername,
      command: configCredentials.command,
      steps: configCredentials.interactionSteps,
      collect: configCredentials.collect,
    });
    if (!relayValidation.ok) {
      return { ok: false, reason: relayValidation.error };
    }

    return { ok: true };
  }

  async fetchCatalog(configCredentials: unknown): Promise<{
    ok: boolean;
    messages?: string[];
    buttons?: any[];
    baselineId?: number;
    messageIds?: number[];
    [key: string]: any;
  }> {
    const validation = this.validate(configCredentials);
    if (!validation.ok) {
      throw new Error(`Invalid Telegram bot configuration: ${validation.reason}`);
    }

    const relayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL!.trim();
    const relayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN!.trim();

    const cfg = configCredentials as Record<string, any>;
    const cleanUsername = String(cfg.botUsername).trim().replace(/^@+/, '');

    const payload: Record<string, any> = {
      botUsername: cleanUsername,
    };
    if (cfg.interactionSteps) {
      payload.steps = cfg.interactionSteps;
    } else if (cfg.command) {
      payload.command = cfg.command;
    }
    if (cfg.collect) {
      payload.collect = cfg.collect;
    }
    if (cfg.includeButtons !== undefined) {
      payload.includeButtons = cfg.includeButtons;
    } else if (cfg.parseMode === 'buttons') {
      payload.includeButtons = true;
    }

    const cleanUrl = relayUrl.replace(/\/+$/, '');
    const endpoint = cleanUrl.endsWith('/relay') ? cleanUrl : `${cleanUrl}/relay`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${relayToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Relay HTTP ${response.status}: ${text || response.statusText}`);
    }

    const data = await response.json();
    if (!data || data.ok !== true || data.error) {
      throw new Error(data?.error || 'Relay interaction failed');
    }

    return data;
  }
}
