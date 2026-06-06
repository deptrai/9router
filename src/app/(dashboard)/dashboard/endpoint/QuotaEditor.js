"use client";

/**
 * QuotaEditor — C2/C3/C4: Form cấu hình quota per API key
 *
 * - Bật/tắt quota, bảng limit (model/window/maxTokens), add/remove
 * - Hiển thị usage: progress bar consumed/max + countdown reset
 * - Model dropdown lấy từ /api/models (canonical model id) + option "*"
 * - GET khi mở, PUT khi Save, toast kết quả
 */

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { Button, Toggle } from "@/shared/components";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTokens(n) {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

// ── UsageRow — C3: progress bar + countdown ──────────────────────────────────

function UsageRow({ u }) {
  const pct = u.maxTokens > 0 ? Math.min((u.consumed / u.maxTokens) * 100, 100) : 0;
  const exceeded = u.consumed >= u.maxTokens;

  return (
    <div className="py-1.5 border-b border-border/30 last:border-0">
      <div className="flex items-center justify-between text-xs mb-1 gap-2">
        <span className="font-mono text-text-muted truncate max-w-[200px]" title={u.model}>
          {u.model === "*" ? "* (tất cả)" : u.model}
        </span>
        <span className="shrink-0 text-text-muted">{u.window}</span>
        <span
          className={`shrink-0 font-medium ${exceeded ? "text-red-500" : "text-text-primary"}`}
        >
          {formatTokens(u.consumed)} / {formatTokens(u.maxTokens)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${exceeded ? "bg-red-500" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {exceeded ? (
        <p className="text-xs text-red-500 mt-0.5">Exceeded — {u.resetHuman}</p>
      ) : (
        <p className="text-xs text-text-muted mt-0.5">{u.resetHuman}</p>
      )}
    </div>
  );
}

UsageRow.propTypes = {
  u: PropTypes.shape({
    model: PropTypes.string,
    window: PropTypes.string,
    consumed: PropTypes.number,
    maxTokens: PropTypes.number,
    resetAt: PropTypes.string,
    resetHuman: PropTypes.string,
  }).isRequired,
};

// ── LimitRow — bảng cấu hình 1 limit ─────────────────────────────────────────

function LimitRow({ limit, index, models, onChange, onRemove }) {
  return (
    <tr className="border-b border-border/30 last:border-0">
      {/* Model dropdown — C4 */}
      <td className="py-1.5 pr-2">
        <select
          value={limit.model}
          onChange={(e) => onChange(index, "model", e.target.value)}
          className="w-full text-xs bg-surface-1 border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="*">* (tất cả model)</option>
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </td>
      {/* Window */}
      <td className="py-1.5 pr-2">
        <select
          value={limit.window}
          onChange={(e) => onChange(index, "window", e.target.value)}
          className="text-xs bg-surface-1 border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="5h">5h</option>
          <option value="weekly">weekly</option>
        </select>
      </td>
      {/* maxTokens */}
      <td className="py-1.5 pr-2">
        <input
          type="number"
          min={1}
          value={limit.maxTokens}
          onChange={(e) => onChange(index, "maxTokens", e.target.value)}
          className="w-28 text-xs bg-surface-1 border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="200000"
        />
      </td>
      {/* Remove */}
      <td className="py-1.5 text-right">
        <button
          onClick={() => onRemove(index)}
          className="p-1 text-text-muted hover:text-red-500 transition-colors"
          title="Xoá limit"
        >
          <span className="material-symbols-outlined text-[16px]">remove_circle_outline</span>
        </button>
      </td>
    </tr>
  );
}

LimitRow.propTypes = {
  limit: PropTypes.object.isRequired,
  index: PropTypes.number.isRequired,
  models: PropTypes.array.isRequired,
  onChange: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};

// ── QuotaEditor — component chính ────────────────────────────────────────────

export default function QuotaEditor({ keyId }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { type: "success"|"error", msg }

  const [enabled, setEnabled] = useState(false);
  const [limits, setLimits] = useState([]);
  const [usage, setUsage] = useState([]);

  // C4: model list từ API
  const [modelOptions, setModelOptions] = useState([]);

  const showToast = (type, msg) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3000);
  };

  // Load model list một lần
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((data) => {
        const opts = (data.models || []).map((m) => ({
          value: m.model, // canonical model id
          label: `${m.provider}/${m.model}`,
        }));
        setModelOptions(opts);
      })
      .catch(() => {});
  }, []);

  // Load quota config + usage khi mở accordion
  const loadQuota = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/keys/${keyId}/quota`);
      if (!res.ok) throw new Error("Fetch failed");
      const data = await res.json();
      setEnabled(data.config?.enabled ?? false);
      setLimits(data.config?.limits || []);
      setUsage(data.usage || []);
    } catch {
      showToast("error", "Không tải được quota config");
    } finally {
      setLoading(false);
    }
  }, [keyId]);

  useEffect(() => {
    if (open) loadQuota();
  }, [open, loadQuota]);

  const handleLimitChange = (index, field, value) => {
    setLimits((prev) =>
      prev.map((l, i) =>
        i === index ? { ...l, [field]: field === "maxTokens" ? Number(value) : value } : l
      )
    );
  };

  const handleAddLimit = () => {
    setLimits((prev) => [
      ...prev,
      { model: "*", window: "5h", maxTokens: 200000 },
    ]);
  };

  const handleRemoveLimit = (index) => {
    setLimits((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/keys/${keyId}/quota`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, limits }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast("error", data.error || "Lưu thất bại");
        return;
      }
      showToast("success", "Quota đã lưu");
      // Reload usage sau khi save
      loadQuota();
    } catch {
      showToast("error", "Lỗi kết nối");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 border border-border/50 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-surface-2/50 hover:bg-surface-2 transition-colors text-sm"
      >
        <span className="flex items-center gap-2 text-text-muted font-medium">
          <span className="material-symbols-outlined text-[16px]">monitoring</span>
          Quota
          {enabled && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary font-normal">
              {limits.length} limit{limits.length !== 1 ? "s" : ""}
            </span>
          )}
        </span>
        <span className="material-symbols-outlined text-[16px] text-text-muted">
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>

      {/* Body */}
      {open && (
        <div className="px-3 py-3 relative">
          {/* Toast */}
          {toast && (
            <div
              className={`absolute top-2 right-2 px-3 py-1.5 rounded text-xs font-medium z-10 shadow ${
                toast.type === "success"
                  ? "bg-green-500/10 text-green-600 border border-green-500/20"
                  : "bg-red-500/10 text-red-500 border border-red-500/20"
              }`}
            >
              {toast.msg}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-4 text-text-muted text-sm">
              <span className="material-symbols-outlined animate-spin mr-2 text-[16px]">progress_activity</span>
              Đang tải...
            </div>
          ) : (
            <>
              {/* Toggle enabled */}
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium">Bật quota</span>
                <Toggle value={enabled} onChange={setEnabled} />
              </div>

              {/* Usage display — C3 */}
              {usage.length > 0 && (
                <div className="mb-3 bg-surface-2/50 rounded-lg p-2.5">
                  <p className="text-xs text-text-muted font-medium mb-2">Usage hiện tại</p>
                  {usage.map((u, i) => (
                    <UsageRow key={i} u={u} />
                  ))}
                </div>
              )}

              {/* Limits table — C2 */}
              {enabled && (
                <>
                  <div className="mb-2">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/50">
                          <th className="text-left text-xs text-text-muted pb-1.5 font-medium pr-2">Model</th>
                          <th className="text-left text-xs text-text-muted pb-1.5 font-medium pr-2">Window</th>
                          <th className="text-left text-xs text-text-muted pb-1.5 font-medium pr-2">Max tokens</th>
                          <th className="text-right text-xs text-text-muted pb-1.5 font-medium" />
                        </tr>
                      </thead>
                      <tbody>
                        {limits.map((l, i) => (
                          <LimitRow
                            key={i}
                            limit={l}
                            index={i}
                            models={modelOptions}
                            onChange={handleLimitChange}
                            onRemove={handleRemoveLimit}
                          />
                        ))}
                      </tbody>
                    </table>
                    {limits.length === 0 && (
                      <p className="text-xs text-text-muted text-center py-2">
                        Chưa có limit — nhấn &quot;+ Thêm limit&quot;
                      </p>
                    )}
                  </div>

                  <button
                    onClick={handleAddLimit}
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors mb-3"
                  >
                    <span className="material-symbols-outlined text-[14px]">add_circle_outline</span>
                    Thêm limit
                  </button>
                </>
              )}

              {/* Save button */}
              <div className="flex justify-end">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? "Đang lưu..." : "Lưu quota"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

QuotaEditor.propTypes = {
  keyId: PropTypes.string.isRequired,
};
