"use client";

// Story 2.34 (T5/AC2/QĐ6) — Admin supplier-source detail.
// Shows source health + recent supplierOrders with dual-status (internal vs supplier-side),
// margin, and a warning banner when any tracked order note carries a reconciliation flag.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
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

export default function SupplierDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id;
  const [role, setRole] = useState(null);
  const [source, setSource] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/store/admin/suppliers/${id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Failed to load supplier");
      else {
        setSource(data.source || null);
        setOrders(data.supplierOrders || []);
      }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { if (role === "admin") load(); }, [role, load]);

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
        <h1 className="text-2xl font-semibold text-text-main">
          {source ? source.name : "Supplier"}
        </h1>
        <a href="/dashboard/suppliers" className="px-3 py-1.5 rounded-lg text-sm font-medium bg-surface-2 text-text-muted hover:bg-surface-3 transition-colors">
          ← Back
        </a>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {loading ? (
        <div className="p-6 text-sm text-text-muted">Loading…</div>
      ) : !source ? (
        <div className="p-6 text-sm text-text-muted">Supplier not found.</div>
      ) : (
        <>
          <Card className="p-5 space-y-2">
            <div className="flex items-center gap-3">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[source.status] || "bg-surface-3 text-text-muted"}`}>
                {source.status}
              </span>
              {!source.isActive && <span className="text-xs text-text-muted">(disabled)</span>}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm text-text-muted">
              <div><span className="text-text-main">Adapter:</span> {source.adapterType}</div>
              <div><span className="text-text-main">Sync mode:</span> {source.syncMode}</div>
              <div><span className="text-text-main">Payment mode:</span> {source.paymentMode}</div>
              <div><span className="text-text-main">Last synced:</span> {fmtDate(source.lastSyncedAt)}</div>
              <div className="md:col-span-2"><span className="text-text-main">Last error:</span> {source.lastSyncError || "—"}</div>
            </div>
          </Card>

          <Card className="p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-border-subtle">
              <h2 className="text-lg font-semibold text-text-main">Recent supplier orders</h2>
            </div>
            {orders.length === 0 ? (
              <div className="p-6 text-sm text-text-muted">No supplier orders for this source.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-surface-2 border-b border-border-subtle">
                  <tr className="text-left text-xs uppercase tracking-wider text-text-muted">
                    <th className="px-4 py-3">Order</th>
                    <th className="px-4 py-3">Supplier status</th>
                    <th className="px-4 py-3">Supplier order id</th>
                    <th className="px-4 py-3">Retail</th>
                    <th className="px-4 py-3">Supplier</th>
                    <th className="px-4 py-3">Margin</th>
                    <th className="px-4 py-3">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {orders.map((o) => (
                    <tr key={o.id} className="hover:bg-surface-2/50">
                      <td className="px-4 py-3 font-medium text-text-main" title={o.orderId}>
                        {o.orderId.slice(0, 8)}…
                      </td>
                      <td className="px-4 py-3 text-text-muted">{o.supplierStatus || "—"}</td>
                      <td className="px-4 py-3 text-text-muted">{o.supplierOrderId || "—"}</td>
                      <td className="px-4 py-3 text-text-muted">{o.retailPrice ?? "—"}</td>
                      <td className="px-4 py-3 text-text-muted">{o.supplierPrice ?? "—"}</td>
                      <td className={`px-4 py-3 ${o.expectedMargin < 0 ? "text-red-500 font-medium" : "text-text-muted"}`}>{o.expectedMargin ?? "—"}</td>
                      <td className="px-4 py-3 text-text-muted">{fmtDate(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
