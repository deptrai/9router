"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/shared/components";

const TABS = ["products", "orders"];
const PRODUCT_KINDS = ["plan", "credential", "account", "service", "api_package"];
const DELIVERY_MODES = ["instant", "admin_fulfill", "user_self_connect"];

export default function StorePage() {
  const router = useRouter();
  const [role, setRole] = useState(null);
  const [tab, setTab] = useState("products");

  // Products state
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "", kind: "plan", priceCredits: "", deliveryMode: "instant",
    description: "", targetType: "", targetId: "", isActive: true,
  });
  const [saving, setSaving] = useState(false);

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

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/store/admin/products");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Failed to load products");
      else setProducts(data.products || []);
    } catch { setError("Network error"); }
    setLoading(false);
  }, []);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/store/admin/orders");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Failed to load orders");
      else setOrders(data.orders || []);
    } catch { setError("Network error"); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (role !== "admin") return;
    if (tab === "products") loadProducts();
    else if (tab === "orders") loadOrders();
  }, [role, tab, loadProducts, loadOrders]);

  const createProduct = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: form.name,
        kind: form.kind,
        priceCredits: Number(form.priceCredits),
        deliveryMode: form.deliveryMode,
        description: form.description || undefined,
        targetType: form.targetType || undefined,
        targetId: form.targetId || undefined,
        isActive: form.isActive,
      };
      const res = await fetch("/api/store/admin/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Failed to create product");
      else {
        setForm({ name: "", kind: "plan", priceCredits: "", deliveryMode: "instant", description: "", targetType: "", targetId: "", isActive: true });
        setShowForm(false);
        await loadProducts();
      }
    } catch { setError("Network error"); }
    setSaving(false);
  };

  const toggleProduct = async (id, isActive) => {
    await fetch(`/api/store/admin/products/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !isActive }),
    });
    await loadProducts();
  };

  const deleteProduct = async (id) => {
    if (!confirm("Xóa sản phẩm này?")) return;
    await fetch(`/api/store/admin/products/${id}`, { method: "DELETE" });
    await loadProducts();
  };

  const fulfillOrder = async (id) => {
    await fetch(`/api/store/admin/orders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "fulfilled" }),
    });
    await loadOrders();
  };

  if (role === null) return <div className="p-6"><div className="h-8 rounded bg-surface-2 animate-pulse w-48" /></div>;
  if (role === "user") return null;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-main">Store Management</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-1 rounded-lg p-1 w-fit">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
              tab === t ? "bg-white dark:bg-surface-3 text-text-main shadow-sm" : "text-text-muted hover:text-text-main"
            }`}
          >
            {t === "products" ? "Products" : "Orders"}
          </button>
        ))}
      </div>

      {error && <div className="text-red-500 text-sm bg-red-500/10 px-4 py-2 rounded-lg">{error}</div>}

      {/* Products Tab */}
      {tab === "products" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              New Product
            </button>
          </div>

          {showForm && (
            <Card>
              <form onSubmit={createProduct} className="p-4 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-text-muted mb-1">Name *</label>
                    <input
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-muted mb-1">Kind *</label>
                    <select
                      value={form.kind}
                      onChange={(e) => setForm({ ...form, kind: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main"
                    >
                      {PRODUCT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-muted mb-1">Price (credits) *</label>
                    <input
                      type="number"
                      value={form.priceCredits}
                      onChange={(e) => setForm({ ...form, priceCredits: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main"
                      required min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-muted mb-1">Delivery Mode *</label>
                    <select
                      value={form.deliveryMode}
                      onChange={(e) => setForm({ ...form, deliveryMode: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main"
                    >
                      {DELIVERY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-muted mb-1">Target Type</label>
                    <input
                      value={form.targetType}
                      onChange={(e) => setForm({ ...form, targetType: e.target.value })}
                      placeholder="e.g. 9router_plan"
                      className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-muted mb-1">Target ID</label>
                    <input
                      value={form.targetId}
                      onChange={(e) => setForm({ ...form, targetId: e.target.value })}
                      placeholder="Plan ID or resource ID"
                      className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-text-muted mb-1">Description</label>
                    <textarea
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      rows={2}
                      className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main resize-none"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-text-muted">
                    <input
                      type="checkbox"
                      checked={form.isActive}
                      onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                      className="rounded"
                    />
                    Active
                  </label>
                  <div className="flex-1" />
                  <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-text-muted hover:text-text-main">
                    Cancel
                  </button>
                  <button type="submit" disabled={saving} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                    {saving ? "Saving..." : "Create Product"}
                  </button>
                </div>
              </form>
            </Card>
          )}

          {loading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-16 rounded-lg bg-surface-2 animate-pulse" />)}</div>
          ) : products.length === 0 ? (
            <Card><div className="p-8 text-center text-text-muted">No products yet. Create one to get started.</div></Card>
          ) : (
            <div className="space-y-2">
              {products.map((p) => (
                <Card key={p.id}>
                  <div className="p-4 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-main text-sm truncate">{p.name}</span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${p.isActive ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-500"}`}>
                          {p.isActive ? "Active" : "Inactive"}
                        </span>
                        <span className="px-2 py-0.5 rounded text-xs bg-surface-2 text-text-muted">{p.kind}</span>
                        {p.source !== "local" && <span className="px-2 py-0.5 rounded text-xs bg-blue-500/10 text-blue-600">external</span>}
                      </div>
                      <div className="text-xs text-text-muted mt-1">
                        {p.priceCredits.toLocaleString()} credits · {p.deliveryMode}
                        {p.stock !== null && ` · stock: ${p.stock}`}
                        {p.description && ` · ${p.description.slice(0, 60)}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleProduct(p.id, p.isActive)}
                        className="p-1.5 rounded-lg hover:bg-surface-2 text-text-muted hover:text-text-main transition-colors"
                        title={p.isActive ? "Deactivate" : "Activate"}
                      >
                        <span className="material-symbols-outlined text-[18px]">{p.isActive ? "toggle_on" : "toggle_off"}</span>
                      </button>
                      <button
                        onClick={() => deleteProduct(p.id)}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-text-muted hover:text-red-500 transition-colors"
                        title="Delete"
                      >
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Orders Tab */}
      {tab === "orders" && (
        <div className="space-y-4">
          {loading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-16 rounded-lg bg-surface-2 animate-pulse" />)}</div>
          ) : orders.length === 0 ? (
            <Card><div className="p-8 text-center text-text-muted">No orders yet.</div></Card>
          ) : (
            <div className="space-y-2">
              {orders.map((o) => (
                <Card key={o.id}>
                  <div className="p-4 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-text-muted">{o.id?.slice(0, 8)}</span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          o.status === "fulfilled" ? "bg-green-500/10 text-green-600" :
                          o.status === "paid" ? "bg-yellow-500/10 text-yellow-600" :
                          o.status === "pending" ? "bg-blue-500/10 text-blue-600" :
                          "bg-red-500/10 text-red-500"
                        }`}>
                          {o.status}
                        </span>
                      </div>
                      <div className="text-xs text-text-muted mt-1">
                        User: {o.userId?.slice(0, 8)} · {o.totalCredits?.toLocaleString()} credits · {new Date(o.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    {o.status === "paid" && (
                      <button
                        onClick={() => fulfillOrder(o.id)}
                        className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 transition-colors"
                      >
                        Fulfill
                      </button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
