"use client";

import { validateRelayRequest } from "@/lib/telegram/relayCore.js";

export const ADAPTER_TYPES = [
  "supplier_api",
  "channel_feed",
  "polling_feed",
  "webhook",
  "telegram_bot_scraper",
];

export const SYNC_MODES = ["polling", "webhook"];
export const PAYMENT_MODES = ["proxy_checkout", "auto_fulfill"];

const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

const ADAPTER_MIN_SYNC_INTERVAL = {
  telegram_bot_scraper: 3600,
  __default: 60,
};

const ADAPTER_FIELD_SCHEMAS = {
  supplier_api: {
    fields: [
      { key: "apiUrl", label: "API URL", type: "url", required: true },
      { key: "apiKey", label: "API Key", type: "password", required: false },
      { key: "bearerToken", label: "Bearer Token", type: "password", required: false },
    ],
    hint: "Provide apiUrl and either apiKey or bearerToken.",
  },
  channel_feed: {
    fields: [
      { key: "feedUrl", label: "Feed URL", type: "url", required: true },
      { key: "apiKey", label: "API Key (optional)", type: "password", required: false },
      { key: "bearerToken", label: "Bearer Token (optional)", type: "password", required: false },
    ],
    hint: "Public RSS/Atom/JSON feed URL. Credentials only if the feed is protected.",
  },
  polling_feed: {
    fields: [
      { key: "feedUrl", label: "Feed URL", type: "url", required: true },
      { key: "apiKey", label: "API Key (optional)", type: "password", required: false },
      { key: "bearerToken", label: "Bearer Token (optional)", type: "password", required: false },
    ],
    hint: "Polling JSON delta feed. Credentials only if the endpoint is protected.",
  },
  webhook: {
    fields: [
      { key: "webhookSecret", label: "Webhook Secret", type: "password", required: true },
    ],
    hint: "Secret used to verify incoming webhook signatures.",
  },
  telegram_bot_scraper: {
    fields: [
      { key: "botUsername", label: "Bot Username", type: "text", required: true },
      { key: "vndPerCredit", label: "VND per Credit", type: "number", required: true },
      { key: "relayUrl", label: "Relay URL", type: "url", required: true },
      { key: "relayToken", label: "Relay Token", type: "password", required: true },
    ],
    hasCommandToggle: true,
    hint: "Legacy command or interactive send/press steps.",
  },
};

export function getFieldSchema(adapterType) {
  return ADAPTER_FIELD_SCHEMAS[adapterType] || null;
}

export function getDefaultForm(adapterType = "telegram_bot_scraper") {
  return {
    name: "",
    adapterType,
    syncMode: "polling",
    syncIntervalSec: adapterType === "telegram_bot_scraper" ? 3600 : 60,
    paymentMode: adapterType === "telegram_bot_scraper" ? "auto_fulfill" : "proxy_checkout",
    isActive: true,
    auth: getDefaultAuth(adapterType),
    mode: "command", // for telegram_bot_scraper: 'command' | 'interactive'
    purchaseMode: "purchaseCommand", // 'purchaseCommand' | 'purchaseInteractive'
    updateCredentials: true,
    clearAuth: false,
  };
}

function getDefaultAuth(adapterType) {
  if (adapterType === "telegram_bot_scraper") {
    return {
      botUsername: "",
      vndPerCredit: "",
      relayUrl: "",
      relayToken: "",
      command: "",
      interactionSteps: [
        { action: "send", text: "", match: "exact", collect: false },
      ],
      collect: { timeoutMs: 30000, idleMs: 1500, maxMessages: 20 },
      purchaseCommand: "",
      purchaseSteps: [
        { action: "send", text: "", match: "exact", collect: false },
      ],
      purchaseCollect: { timeoutMs: 60000, idleMs: 3000, maxMessages: 20 },
    };
  }
  const schema = ADAPTER_FIELD_SCHEMAS[adapterType];
  if (!schema) return {};
  const auth = {};
  for (const field of schema.fields) {
    auth[field.key] = "";
  }
  return auth;
}

export function normalizeBotUsername(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^@+/, "");
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateSupplierSourceForm(data, { isEdit = false } = {}) {
  const errors = {};
  const skipAuth = isEdit && data.updateCredentials === false && !data.clearAuth;

  if (!nonEmptyString(data.name)) {
    errors.name = "Name is required";
  }

  if (!ADAPTER_TYPES.includes(data.adapterType)) {
    errors.adapterType = "Invalid adapter type";
  }

  if (!SYNC_MODES.includes(data.syncMode)) {
    errors.syncMode = "Invalid sync mode";
  }

  if (data.paymentMode !== undefined && !PAYMENT_MODES.includes(data.paymentMode)) {
    errors.paymentMode = "Invalid payment mode";
  }

  const syncInterval = Number(data.syncIntervalSec);
  if (!Number.isFinite(syncInterval)) {
    errors.syncIntervalSec = "Sync interval must be a number";
  } else {
    const min = ADAPTER_MIN_SYNC_INTERVAL[data.adapterType] ?? ADAPTER_MIN_SYNC_INTERVAL.__default;
    if (syncInterval < min) {
      errors.syncIntervalSec = `Sync interval must be >= ${min} seconds for ${data.adapterType}`;
    }
  }

  if (!skipAuth) {
    if (data.adapterType === "telegram_bot_scraper") {
      const auth = data.auth || {};
      const botUsername = normalizeBotUsername(auth.botUsername);
      if (!BOT_USERNAME_RE.test(botUsername)) {
        errors.botUsername = "Must be a Telegram username: 5-32 chars, start with a letter, only letters/digits/underscore";
      }

      if (!positiveNumber(auth.vndPerCredit)) {
        errors.vndPerCredit = "Must be a number greater than 0";
      }

      if (!nonEmptyString(auth.relayUrl)) {
        errors.relayUrl = "Relay URL is required";
      }

      if (!nonEmptyString(auth.relayToken)) {
        errors.relayToken = "Relay token is required";
      }

      const mode = data.mode || "command";
      if (mode === "command") {
        if (!nonEmptyString(auth.command)) {
          errors.command = "Command is required in single-command mode";
        }
      } else {
        const validation = validateRelayRequest({
          botUsername,
          steps: auth.interactionSteps,
          collect: auth.collect,
        });
        if (!validation.ok) {
          errors.interactionSteps = validation.error;
        }
      }

      if (data.paymentMode === "auto_fulfill") {
        const purchaseMode = data.purchaseMode || "purchaseCommand";
        if (purchaseMode === "purchaseCommand") {
          if (!nonEmptyString(auth.purchaseCommand)) {
            errors.purchaseCommand = "Purchase command is required";
          }
        } else {
          const purchaseValidation = validateRelayRequest({
            botUsername,
            steps: auth.purchaseSteps,
            collect: auth.purchaseCollect,
          });
          if (!purchaseValidation.ok) {
            errors.purchaseSteps = purchaseValidation.error;
          }
        }
      }
    } else {
      const schema = ADAPTER_FIELD_SCHEMAS[data.adapterType];
      if (schema) {
        for (const field of schema.fields) {
          if (field.required && !nonEmptyString((data.auth || {})[field.key])) {
            errors[field.key] = `${field.label} is required`;
          }
        }
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

export function buildSupplierSourcePayload(data, { isEdit = false } = {}) {
  const payload = {
    name: data.name.trim(),
    adapterType: data.adapterType,
    syncMode: data.syncMode,
    syncIntervalSec: Number(data.syncIntervalSec),
    paymentMode: data.paymentMode,
    isActive: data.isActive,
  };

  if (isEdit && data.clearAuth) {
    payload.auth = null;
    return payload;
  }

  // Edit without updating credentials: send only generic fields.
  if (isEdit && data.updateCredentials === false) {
    return payload;
  }

  const auth = {};

  if (data.adapterType === "telegram_bot_scraper") {
    const src = data.auth || {};
    auth.botUsername = normalizeBotUsername(src.botUsername);
    auth.vndPerCredit = Number(src.vndPerCredit);
    auth.relayUrl = (src.relayUrl || "").trim();
    auth.relayToken = (src.relayToken || "").trim();

    if (data.mode === "interactive") {
      const validation = validateRelayRequest({
        botUsername: auth.botUsername,
        steps: src.interactionSteps,
        collect: src.collect,
      });
      if (validation.ok) {
        auth.interactionSteps = validation.value.steps;
        auth.collect = validation.value.collect;
      } else {
        auth.interactionSteps = src.interactionSteps;
        auth.collect = src.collect;
      }
      auth.command = undefined;
    } else {
      auth.command = (src.command || "").trim();
      auth.interactionSteps = undefined;
      auth.collect = undefined;
    }

    // Story 2-38.2: purchase flow config (only for auto_fulfill).
    if (data.paymentMode === "auto_fulfill") {
      if (data.purchaseMode === "purchaseInteractive") {
        const purchaseValidation = validateRelayRequest({
          botUsername: auth.botUsername,
          steps: src.purchaseSteps,
          collect: src.purchaseCollect,
        });
        if (purchaseValidation.ok) {
          auth.purchaseSteps = purchaseValidation.value.steps;
          auth.purchaseCollect = purchaseValidation.value.collect;
        } else {
          auth.purchaseSteps = src.purchaseSteps;
          auth.purchaseCollect = src.purchaseCollect;
        }
        auth.purchaseCommand = undefined;
      } else {
        auth.purchaseCommand = (src.purchaseCommand || "").trim();
        auth.purchaseSteps = undefined;
        auth.purchaseCollect = undefined;
      }
    } else {
      auth.purchaseCommand = undefined;
      auth.purchaseSteps = undefined;
      auth.purchaseCollect = undefined;
    }
  } else {
    const schema = ADAPTER_FIELD_SCHEMAS[data.adapterType];
    if (schema) {
      for (const field of schema.fields) {
        const value = (data.auth || {})[field.key];
        if (value !== undefined && value !== null) {
          auth[field.key] = field.type === "number" ? Number(value) : value;
        }
      }
    }
  }

  payload.auth = auth;
  return payload;
}
