"use client";

import { useState } from "react";
import { cn } from "@/shared/utils/cn";
import Input from "./Input";
import Button from "./Button";
import ScraperStepsEditor from "./ScraperStepsEditor";
import {
  ADAPTER_TYPES,
  SYNC_MODES,
  PAYMENT_MODES,
  getDefaultForm,
  getFieldSchema,
  validateSupplierSourceForm,
  buildSupplierSourcePayload,
} from "@/lib/store/suppliers/supplierSourceForm.js";

const ADAPTER_LABELS = {
  supplier_api: "Supplier API",
  channel_feed: "Channel Feed",
  polling_feed: "Polling Feed",
  webhook: "Webhook",
  telegram_bot_scraper: "Telegram Bot Scraper",
};

export default function SupplierSourceForm({
  mode = "create",
  source,
  onSubmit,
  onCancel,
  onTestSync,
  loading = false,
  serverError = "",
}) {
  const isEdit = mode === "edit";
  const [form, setForm] = useState(() =>
    source ? initializeFromSource(source) : getDefaultForm("telegram_bot_scraper")
  );
  const [validation, setValidation] = useState({ ok: true, errors: {} });
  const [touched, setTouched] = useState(false);

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setAuthField = (key, value) => {
    setForm((prev) => ({
      ...prev,
      auth: { ...prev.auth, [key]: value },
    }));
  };

  const handleAdapterTypeChange = (adapterType) => {
    if (adapterType === form.adapterType) return;
    const next = getDefaultForm(adapterType);
    next.updateCredentials = form.updateCredentials;
    next.clearAuth = form.clearAuth;
    next.name = form.name;
    next.syncMode = form.syncMode;
    next.syncIntervalSec = form.syncIntervalSec;
    next.isActive = form.isActive;
    setForm(next);
    setTouched(false);
  };

  const handleSubmit = () => {
    setTouched(true);
    const result = validateSupplierSourceForm(form, { isEdit });
    setValidation(result);
    if (!result.ok) return;

    const payload = buildSupplierSourcePayload(form, { isEdit });
    onSubmit(payload);
  };

  const handleTestSync = () => {
    if (onTestSync) onTestSync();
  };

  const schema = getFieldSchema(form.adapterType);
  const errors = touched ? validation.errors : {};
  const showServerError = serverError || (!touched && validation.ok === false ? validation.errors : null);

  return (
    <div className="space-y-5">
      {serverError && (
        <p className="text-sm text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[16px]">error</span>
          {serverError}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          id="supplier-source-name"
          label="Name"
          value={form.name}
          onChange={(e) => setField("name", e.target.value)}
          error={errors.name}
          required
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="supplier-source-adapter" className="text-sm font-medium text-text-main">
            Adapter <span className="text-red-500">*</span>
          </label>
          <select
            id="supplier-source-adapter"
            value={form.adapterType}
            onChange={(e) => handleAdapterTypeChange(e.target.value)}
            disabled={isEdit}
            className="w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[10px] border border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
          >
            {ADAPTER_TYPES.map((t) => (
              <option key={t} value={t}>{ADAPTER_LABELS[t]}</option>
            ))}
          </select>
          {errors.adapterType && <p className="text-xs text-red-500">{errors.adapterType}</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="supplier-source-sync-mode" className="text-sm font-medium text-text-main">Sync mode</label>
          <select
            id="supplier-source-sync-mode"
            value={form.syncMode}
            onChange={(e) => setField("syncMode", e.target.value)}
            className="w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[10px] border border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          >
            {SYNC_MODES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {errors.syncMode && <p className="text-xs text-red-500">{errors.syncMode}</p>}
        </div>
        <Input
          id="supplier-source-sync-interval"
          label="Sync interval (sec)"
          type="number"
          value={form.syncIntervalSec}
          onChange={(e) => setField("syncIntervalSec", e.target.value)}
          error={errors.syncIntervalSec}
          min={0}
          required
        />
        <div className="flex items-center gap-2 pt-6">
          <input
            id="isActive"
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setField("isActive", e.target.checked)}
            className="rounded border-border-subtle"
          />
          <label htmlFor="isActive" className="text-sm text-text-main">Active</label>
        </div>
      </div>

      {isEdit && (
        <div className="p-3 rounded-[10px] border border-border-subtle bg-surface-2/50 space-y-3">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-text-main">
              <input
                type="checkbox"
                checked={form.updateCredentials}
                onChange={(e) => setField("updateCredentials", e.target.checked)}
                className="rounded border-border-subtle"
              />
              Update credentials / auth config
            </label>
            {source?.hasAuth && (
              <label className="flex items-center gap-2 text-sm text-red-500">
                <input
                  type="checkbox"
                  checked={form.clearAuth}
                  onChange={(e) => {
                    setField("clearAuth", e.target.checked);
                    if (e.target.checked) setField("updateCredentials", false);
                  }}
                  className="rounded border-border-subtle"
                />
                Clear saved credentials
              </label>
            )}
          </div>
          {form.updateCredentials && source?.hasAuth && (
            <p className="text-xs text-text-muted">
              Auth fields are not shown for security. Enter the full auth config to overwrite.
            </p>
          )}
        </div>
      )}

      {(!isEdit || form.updateCredentials) && !form.clearAuth && (
        <div className="space-y-4">
          <div className="border-t border-border-subtle pt-4">
            <h3 className="text-sm font-semibold text-text-main mb-3">
              {ADAPTER_LABELS[form.adapterType]} configuration
            </h3>
            {schema?.hint && <p className="text-xs text-text-muted mb-3">{schema.hint}</p>}
          </div>

          {form.adapterType === "telegram_bot_scraper" ? (
            <TelegramBotScraperFields form={form} setField={setField} setAuthField={setAuthField} errors={errors} />
          ) : (
            <GenericAdapterFields schema={schema} auth={form.auth} setAuthField={setAuthField} errors={errors} />
          )}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <Button onClick={handleSubmit} loading={loading} fullWidth>
          {isEdit ? "Save" : "Create"}
        </Button>
        {onTestSync && isEdit && (
          <Button onClick={handleTestSync} variant="secondary" disabled={loading}>
            Test sync
          </Button>
        )}
        <Button onClick={onCancel} variant="ghost" disabled={loading}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function initializeFromSource(source) {
  const form = getDefaultForm(source.adapterType);
  form.name = source.name || "";
  form.adapterType = source.adapterType;
  form.syncMode = source.syncMode || "polling";
  form.syncIntervalSec = source.syncIntervalSec ?? 3600;
  form.paymentMode = source.paymentMode || "proxy_checkout";
  form.isActive = source.isActive !== false;
  form.updateCredentials = false;
  form.clearAuth = false;
  return form;
}

function GenericAdapterFields({ schema, auth, setAuthField, errors }) {
  if (!schema) return null;
  return (
    <div className="grid grid-cols-1 gap-4">
      {schema.fields.map((field) => (
        <Input
          key={field.key}
          id={`supplier-source-${field.key}`}
          label={field.label}
          type={field.type}
          value={auth[field.key] || ""}
          onChange={(e) => setAuthField(field.key, e.target.value)}
          error={errors[field.key]}
          required={field.required}
        />
      ))}
    </div>
  );
}

function TelegramBotScraperFields({ form, setField, setAuthField, errors }) {
  const auth = form.auth;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          id="supplier-source-bot-username"
          label="Bot username"
          value={auth.botUsername || ""}
          onChange={(e) => setAuthField("botUsername", e.target.value)}
          error={errors.botUsername}
          required
          hint="Telegram username, e.g. tainguyenvibebot"
        />
        <Input
          id="supplier-source-vnd-per-credit"
          label="VND per credit"
          type="number"
          value={auth.vndPerCredit}
          onChange={(e) => setAuthField("vndPerCredit", e.target.value)}
          error={errors.vndPerCredit}
          required
          hint="priceCredits = ceil(priceVnd / vndPerCredit)"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          id="supplier-source-relay-url"
          label="Relay URL"
          type="url"
          value={auth.relayUrl || ""}
          onChange={(e) => setAuthField("relayUrl", e.target.value)}
          error={errors.relayUrl}
          required
          hint="http://127.0.0.1:3800/relay"
        />
        <Input
          id="supplier-source-relay-token"
          label="Relay token"
          type="password"
          value={auth.relayToken || ""}
          onChange={(e) => setAuthField("relayToken", e.target.value)}
          error={errors.relayToken}
          required
          hint="Authorization bearer token for the relay"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="supplier-source-payment-mode" className="text-sm font-medium text-text-main">Payment mode</label>
        <select
          id="supplier-source-payment-mode"
          value={form.paymentMode}
          onChange={(e) => setField("paymentMode", e.target.value)}
          className="w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[10px] border border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        >
          {PAYMENT_MODES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        {errors.paymentMode && <p className="text-xs text-red-500">{errors.paymentMode}</p>}
      </div>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-text-main">
          <input
            type="radio"
            name="mode"
            value="command"
            checked={form.mode === "command"}
            onChange={() => setField("mode", "command")}
            className="rounded border-border-subtle"
          />
          Single command
        </label>
        <label className="flex items-center gap-2 text-sm text-text-main">
          <input
            type="radio"
            name="mode"
            value="interactive"
            checked={form.mode === "interactive"}
            onChange={() => setField("mode", "interactive")}
            className="rounded border-border-subtle"
          />
          Interactive steps
        </label>
      </div>

      {form.mode === "command" ? (
        <Input
          id="supplier-source-command"
          label="Command"
          value={auth.command || ""}
          onChange={(e) => setAuthField("command", e.target.value)}
          error={errors.command}
          required
          hint="e.g. /products"
        />
      ) : (
        <ScraperStepsEditor
          value={{ steps: auth.interactionSteps, collect: auth.collect }}
          onChange={({ steps, collect }) => {
            setAuthField("interactionSteps", steps);
            setAuthField("collect", collect);
          }}
          errors={errors.interactionSteps}
        />
      )}

      {form.paymentMode === "auto_fulfill" && (
        <div className="space-y-4 border-t border-border-subtle pt-4">
          <h3 className="text-sm font-semibold text-text-main">Auto-purchase configuration</h3>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-text-main">
              <input
                type="radio"
                name="purchaseMode"
                value="purchaseCommand"
                checked={form.purchaseMode === "purchaseCommand"}
                onChange={() => setField("purchaseMode", "purchaseCommand")}
                className="rounded border-border-subtle"
              />
              Single purchase command
            </label>
            <label className="flex items-center gap-2 text-sm text-text-main">
              <input
                type="radio"
                name="purchaseMode"
                value="purchaseInteractive"
                checked={form.purchaseMode === "purchaseInteractive"}
                onChange={() => setField("purchaseMode", "purchaseInteractive")}
                className="rounded border-border-subtle"
              />
              Interactive purchase steps
            </label>
          </div>

          {form.purchaseMode === "purchaseCommand" ? (
            <Input
              id="supplier-source-purchase-command"
              label="Purchase command"
              value={auth.purchaseCommand || ""}
              onChange={(e) => setAuthField("purchaseCommand", e.target.value)}
              error={errors.purchaseCommand}
              required
              hint="e.g. /buy {{productName}} — placeholders: {{productName}}, {{supplierProductId}}"
            />
          ) : (
            <ScraperStepsEditor
              value={{ steps: auth.purchaseSteps, collect: auth.purchaseCollect }}
              onChange={({ steps, collect }) => {
                setAuthField("purchaseSteps", steps);
                setAuthField("purchaseCollect", collect);
              }}
              errors={errors.purchaseSteps}
            />
          )}
        </div>
      )}
    </div>
  );
}
