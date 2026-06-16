"use client";

// Story 2.34 (T5/AC1) — Admin supplier operations dashboard.
// Lists external supplier sources with health badge + product counts + actions
// (disable/enable/force-sync) and a manual reconciliation trigger.
//
// Path note: repo convention is (dashboard)/dashboard/<name>/page.js with a role guard via
// /api/auth/status — NOT the dashboard/admin/*.tsx path literal in the story (which predates
// knowing the actual layout). Behaviour matches the spec; location matches the codebase.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/shared/components";

const STATUS_BADGE = {
  active: "bg-green-500/10 text-green-500",
  degraded: "bg-yellow-500/10 text-yellow-600",
  unhealthy: "bg-red-500/10 text-red-500",
  unsupported: "bg-surface-3 text-text-muted",
};

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function SuppliersPage() {
  const router = useRouter();
  const [role, setRole] = useState(null); // null = loading
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileMsg, setReconcileMsg] = useState("");

  // Role guard: admin-only. role=user → redirect away.
  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => {
        const r = d.role ?? "admin";
        setRole(r);
        if (r === "user") router.replace("/dashboard/credits");
      })
      .catch(() => setRole("admin"));
  }, [router]);

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/store/admin/suppliers");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Failed to load suppliers");
      else setSources(data.sources || []);
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (role === "admin") loadSources(); }, [role, loadSources]);

  const act = async (id, path) => {
    setBusyId(id);
    setError("");
    try {
      const res = await fetch(`/api/store/admin/suppliers/${id}/${path}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || `Action ${path} failed`);
      else await loadSources();
    } catch {
      setError("Network error");
    }
    setBusyId(null);
  };

  const forceSync = async (id) => {
    setBusyId(id);
    setError("");
    try {
      // Reuse the 2.30 manual-sync endpoint (POST ?action=sync).
      const res = await fetch(`/api/store/suppliers/${id}?action=sync`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Sync failed");
      else await loadSources();
    } catch {
      setError("Network error");
    }
    setBusyId(null);
  };

  const runReconcile = async () => {
    setReconciling(true);
    setReconcileMsg("");
    try {
      const res = await fetch("/api/store/admin/reconcile", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setReconcileMsg(data.error || "Reconcile failed");
      else setReconcileMsg(`Flagged — orphans: ${data.orphans}, negative margins: ${data.negativeMargins}, stale: ${data.staleOrders}`);
    } catch {
      setReconcileMsg("Network error");
    }
    setReconciling(false);
  };

  if (role === null || role === "user") {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="h-8 w-32 bg-surface-2 animate-pulse rounded" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-main">Supplier Sources</h1>
        <div className="flex gap-2">
          <button onClick={runReconcile} disabled={reconciling} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-white disabled:opacity-60">
            {reconciling ? "Reconciling…" : "Run reconciliation"}
          </button>
          <button onClick={loadSources} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-surface-2 text-text-muted hover:bg-surface-3 transition-colors">
            Refresh
          </button>
        </div>
      </div>

      {reconcileMsg && <p className="text-sm text-text-muted">{reconcileMsg}</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 text-sm text-text-muted">Loading…</div>
        ) : sources.length === 0 ? (
          <div className="p-6 text-sm text-text-muted">No supplier sources found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-border-subtle">
              <tr className="text-left text-xs uppercase tracking-wider text-text-muted">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Adapter</th>
                <th className="px-4 py-3">Sync</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Products</th>
                <th className="px-4 py-3">Last synced</th>
                <th className="px-4 py-3">Last error</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {sources.map((s) => (
                <tr key={s.id} className="hover:bg-surface-2/50">
                  <td className="px-4 py-3 font-medium text-text-main">
                    <a href={`/dashboard/suppliers/${s.id}`} className="hover:underline">{s.name}</a>
                    {!s.isActive && <span className="ml-2 text-xs text-text-muted">(disabled)</span>}
                  </td>
                  <td className="px-4 py-3 text-text-muted">{s.adapterType}</td>
                  <td className="px-4 py-3 text-text-muted">{s.syncMode}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[s.status] || "bg-surface-3 text-text-muted"}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-muted">{s.productCounts.published} / {s.productCounts.total}</td>
                  <td className="px-4 py-3 text-text-muted">{fmtDate(s.lastSyncedAt)}</td>
                  <td className="px-4 py-3 text-text-muted max-w-[200px] truncate" title={s.lastSyncError || ""}>{s.lastSyncError || "—"}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                    <button onClick={() => forceSync(s.id)} disabled={busyId === s.id} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-surface-2 text-text-muted hover:bg-surface-3 disabled:opacity-60">Sync</button>
                    {s.isActive ? (
                      <button onClick={() => act(s.id, "disable")} disabled={busyId === s.id} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 disabled:opacity-60">Disable</button>
                    ) : (
                      <button onClick={() => act(s.id, "enable")} disabled={busyId === s.id} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-green-500/10 text-green-500 hover:bg-green-500/20 disabled:opacity-60">Re-enable</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
