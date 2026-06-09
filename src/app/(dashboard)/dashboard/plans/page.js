"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button } from "@/shared/components";

const EMPTY_FORM = {
  name: "",
  displayName: "",
  rpm: 0,
  quota5h: 0,
  quotaWeekly: 0,
  sortOrder: 0,
  perModelLimitsText: "",
  isActive: true,
};

function formatLimit(value) {
  const num = Number(value || 0);
  return num === 0 ? "Unlimited" : num.toLocaleString();
}

function StatusBadge({ active }) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${active ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
      {active ? "Active" : "Disabled"}
    </span>
  );
}

function PlanModal({ plan, onClose, onSaved }) {
  const [form, setForm] = useState(() => plan ? {
    name: plan.name || "",
    displayName: plan.displayName || "",
    rpm: plan.rpm || 0,
    quota5h: plan.quota5h || 0,
    quotaWeekly: plan.quotaWeekly || 0,
    sortOrder: plan.sortOrder || 0,
    perModelLimitsText: plan.perModelLimits ? JSON.stringify(plan.perModelLimits, null, 2) : "",
    isActive: !!plan.isActive,
  } : EMPTY_FORM);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const setField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    let perModelLimits = null;
    if (form.perModelLimitsText.trim()) {
      try {
        perModelLimits = JSON.parse(form.perModelLimitsText);
      } catch {
        setError("perModelLimits must be valid JSON.");
        return;
      }
    }
    const payload = {
      name: form.name,
      displayName: form.displayName || null,
      rpm: Number(form.rpm),
      quota5h: Number(form.quota5h),
      quotaWeekly: Number(form.quotaWeekly),
      sortOrder: Number(form.sortOrder),
      perModelLimits,
      isActive: !!form.isActive,
    };
    setLoading(true);
    try {
      const res = await fetch(plan ? `/api/plans/${plan.id}` : "/api/plans", {
        method: plan ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "Failed to save plan");
      else { onSaved(); onClose(); }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-bg-main border border-border-subtle rounded-xl shadow-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-text-main">{plan ? "Edit Plan" : "Create Plan"}</h2>
            <p className="text-sm text-yellow-600 dark:text-yellow-400 mt-1">Plan templates apply to assigned users immediately on next request.</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-main"><span className="material-symbols-outlined">close</span></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1 text-sm text-text-main">Name
              <input value={form.name} onChange={(e) => setField("name", e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1" />
            </label>
            <label className="space-y-1 text-sm text-text-main">Display Name
              <input value={form.displayName} onChange={(e) => setField("displayName", e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1" />
            </label>
            {[["rpm", "RPM"], ["quota5h", "5h quota"], ["quotaWeekly", "Weekly quota"], ["sortOrder", "Sort order"]].map(([field, label]) => (
              <label key={field} className="space-y-1 text-sm text-text-main">{label}
                <input type="number" min="0" step="1" value={form[field]} onChange={(e) => setField(field, e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1" />
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-text-main">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setField("isActive", e.target.checked)} />
            Active
          </label>
          <label className="space-y-1 text-sm text-text-main block">perModelLimits JSON <span className="text-text-muted">(enforced for matching canonical model ids)</span>
            <textarea rows={5} value={form.perModelLimitsText} onChange={(e) => setField("perModelLimitsText", e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 font-mono text-xs" placeholder='{"model": {"q5h": 1000, "qWeekly": 5000}}' />
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={loading} icon="save">Save</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function PlansPage() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);

  const loadPlans = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/plans");
      const data = await res.json();
      if (!res.ok) setError(res.status === 403 ? "Access denied — admin only." : data.error || "Failed to load plans.");
      else setPlans(data.plans || []);
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(loadPlans, 0);
    return () => clearTimeout(timer);
  }, [loadPlans]);

  const sorted = useMemo(() => [...plans].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)), [plans]);

  const toggleActive = async (plan) => {
    const res = await fetch(`/api/plans/${plan.id}`, {
      method: plan.isActive ? "DELETE" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: plan.isActive ? undefined : JSON.stringify({ isActive: true }),
    });
    if (res.ok) loadPlans();
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text-main">Plans</h1>
        <div className="flex gap-2">
          <Button variant="secondary" icon="refresh" onClick={loadPlans}>Refresh</Button>
          <Button icon="add" onClick={() => setEditing({})}>New Plan</Button>
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-12 bg-surface-2 animate-pulse rounded" />)}</div>
        ) : error ? (
          <div className="p-6 text-center text-red-500 text-sm">{error}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 border-b border-border-subtle">
                <tr className="text-left text-text-muted text-xs uppercase tracking-wider">
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Limits</th>
                  <th className="px-4 py-3 text-center">Users</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {sorted.map((plan) => (
                  <tr key={plan.id} className="hover:bg-surface-2/50">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-text-main">{plan.displayName || plan.name}</p>
                      <p className="text-xs text-text-muted">{plan.name} • sort {plan.sortOrder || 0}{plan.perModelLimits ? " • per-model stored" : ""}</p>
                    </td>
                    <td className="px-4 py-3 text-text-muted">RPM {formatLimit(plan.rpm)} • 5h {formatLimit(plan.quota5h)} • weekly {formatLimit(plan.quotaWeekly)}</td>
                    <td className="px-4 py-3 text-center text-text-main">{plan.userCount ?? 0}</td>
                    <td className="px-4 py-3 text-center"><StatusBadge active={plan.isActive} /></td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        <Button size="sm" variant="secondary" icon="edit" onClick={() => setEditing(plan)}>Edit</Button>
                        <Button size="sm" variant={plan.isActive ? "danger" : "success"} icon={plan.isActive ? "block" : "restart_alt"} onClick={() => toggleActive(plan)}>{plan.isActive ? "Disable" : "Reactivate"}</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <PlanModal plan={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={loadPlans} />}
    </div>
  );
}
