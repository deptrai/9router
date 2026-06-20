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

  // Shared state
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // User state
  const [balance, setBalance] = useState(0);
  const [buyingProduct, setBuyingProduct] = useState(null);
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseResult, setPurchaseResult] = useState(null);

  // Admin state
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
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
      })
      .catch(() => setRole(null));
  }, []);

  const loadBalance = useCallback(async () => {
    try {
      const res = await fetch("/api/users/me/balance");
      if (res.ok) {
        const data = await res.json();
        setBalance(data.total ?? 0);
      }
    } catch {}
  }, []);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const endpoint = role === "admin" ? "/api/store/admin/products" : "/api/store/products";
      const res = await fetch(endpoint);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Failed to load products");
      else setProducts(data.products || []);
    } catch { setError("Network error"); }
    setLoading(false);
  }, [role]);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const endpoint = role === "admin" ? "/api/store/admin/orders" : "/api/store/orders";
      const res = await fetch(endpoint);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Failed to load orders");
      else setOrders(data.orders || []);
    } catch { setError("Network error"); }
    setLoading(false);
  }, [role]);

  useEffect(() => {
    if (!role) return;
    if (role === "user") {
      loadBalance();
    }
    if (tab === "products") loadProducts();
    else if (tab === "orders") loadOrders();
  }, [role, tab, loadProducts, loadOrders, loadBalance]);

  // Admin actions
  const saveProduct = async (e) => {
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

      const url = editingProduct
        ? `/api/store/admin/products/${editingProduct.id}`
        : "/api/store/admin/products";

      const method = editingProduct ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Failed to save product");
      else {
        setForm({ name: "", kind: "plan", priceCredits: "", deliveryMode: "instant", description: "", targetType: "", targetId: "", isActive: true });
        setShowForm(false);
        setEditingProduct(null);
        await loadProducts();
      }
    } catch { setError("Network error"); }
    setSaving(false);
  };

  const startEdit = (product) => {
    setEditingProduct(product);
    setForm({
      name: product.name || "",
      kind: product.kind || "plan",
      priceCredits: product.priceCredits ?? "",
      deliveryMode: product.deliveryMode || "instant",
      description: product.description || "",
      targetType: product.targetType || "",
      targetId: product.targetId || "",
      isActive: product.isActive !== false,
    });
    setShowForm(true);
  };

  const toggleProduct = async (id, isActive) => {
    try {
      const res = await fetch(`/api/store/admin/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !isActive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to update product");
      }
    } catch { setError("Network error"); }
    await loadProducts();
  };

  const publishAction = async (id, publish) => {
    try {
      const action = publish ? "publish" : "unpublish";
      const res = await fetch(`/api/store/products/${id}/publish?action=${action}`, {
        method: "POST"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to ${action} product`);
      } else {
        await loadProducts();
      }
    } catch { setError("Network error"); }
  };

  const deleteProduct = async (id) => {
    if (!confirm("Xóa sản phẩm này?")) return;
    try {
      const res = await fetch(`/api/store/admin/products/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to delete product");
      }
    } catch { setError("Network error"); }
    await loadProducts();
  };

  const fulfillOrder = async (id) => {
    try {
      const res = await fetch(`/api/store/admin/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fulfill" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to fulfill order");
      }
    } catch { setError("Network error"); }
    await loadOrders();
  };

  // User actions
  const buyProduct = async (productId) => {
    setPurchasing(true);
    setError("");
    try {
      const res = await fetch("/api/store/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, quantity: 1 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Mua hàng thất bại.");
      } else {
        setPurchaseResult(data);
        setBuyingProduct(null);
        await loadBalance();
      }
    } catch { setError("Network error"); }
    setPurchasing(false);
  };

  if (role === null) return <div className="p-6"><div className="h-8 rounded bg-surface-2 animate-pulse w-48" /></div>;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-main">
          {role === "admin" ? "Store Management" : "Cửa hàng"}
        </h1>
        {role === "user" && (
          <div className="flex items-center gap-4 bg-surface-1 border border-border-subtle rounded-lg px-4 py-2">
            <span className="text-sm text-text-muted">Số dư:</span>
            <span className="font-bold text-primary">{balance.toLocaleString()} credits</span>
          </div>
        )}
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
            {t === "products" ? (role === "admin" ? "Products" : "Sản phẩm") : (role === "admin" ? "Orders" : "Đơn hàng")}
          </button>
        ))}
      </div>

      {error && <div className="text-red-500 text-sm bg-red-500/10 px-4 py-2 rounded-lg">{error}</div>}

      {/* Purchase Result Modal for User */}
      {purchaseResult && (
        <Card className="p-6 max-w-md mx-auto space-y-4 border-green-500 bg-green-500/5">
          <div className="flex items-center gap-3 text-green-600">
            <span className="material-symbols-outlined text-[24px]">check_circle</span>
            <span className="font-bold text-lg">{purchaseResult.message}</span>
          </div>
          <div className="text-sm text-text-muted">
            Mã đơn: <code className="font-mono">{purchaseResult.order?.id}</code>
          </div>
          {purchaseResult.credentials && purchaseResult.credentials.length > 0 && (
            <div className="space-y-2">
              <span className="font-medium text-sm text-text-main">Thông tin tài khoản/khóa nhận được:</span>
              {purchaseResult.credentials.map((cred, idx) => (
                <pre key={idx} className="bg-surface-2 border border-border-subtle p-3 rounded-lg font-mono text-xs overflow-x-auto whitespace-pre-wrap select-all">
                  {cred}
                </pre>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <button onClick={() => setPurchaseResult(null)} className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium">
              Đóng
            </button>
          </div>
        </Card>
      )}

      {/* Confirm Buy Modal for User */}
      {buyingProduct && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="p-6 max-w-md w-full space-y-4">
            <h3 className="text-lg font-bold text-text-main">Xác nhận mua</h3>
            <p className="text-sm text-text-muted">
              Bạn có chắc chắn muốn mua <b>{buyingProduct.name}</b> với giá <b>{buyingProduct.priceCredits} credits</b>?
            </p>
            <div className="text-xs text-text-muted space-y-1">
              <div>Số dư hiện tại: {balance.toLocaleString()} credits</div>
              <div>Số dư sau khi mua: {(balance - buyingProduct.priceCredits).toLocaleString()} credits</div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setBuyingProduct(null)}
                className="px-4 py-2 text-sm text-text-muted hover:text-text-main"
                disabled={purchasing}
              >
                Hủy
              </button>
              <button
                onClick={() => buyProduct(buyingProduct.id)}
                className="px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                disabled={purchasing}
              >
                {purchasing ? "Đang xử lý..." : "Xác nhận mua"}
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* Products Tab */}
      {tab === "products" && (
        <div className="space-y-4">
          {role === "admin" && (
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setEditingProduct(null);
                  setForm({ name: "", kind: "plan", priceCredits: "", deliveryMode: "instant", description: "", targetType: "", targetId: "", isActive: true });
                  setShowForm(!showForm);
                }}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                New Product
              </button>
            </div>
          )}

          {showForm && role === "admin" && (
            <Card>
              <form onSubmit={saveProduct} className="p-4 space-y-4">
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
                      disabled={editingProduct && editingProduct.source !== "local"}
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
                      required min="0" step="1"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-muted mb-1">Delivery Mode *</label>
                    <select
                      value={form.deliveryMode}
                      onChange={(e) => setForm({ ...form, deliveryMode: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main"
                      disabled={editingProduct && editingProduct.source !== "local"}
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
                      disabled={editingProduct && editingProduct.source !== "local"}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-muted mb-1">Target ID</label>
                    <input
                      value={form.targetId}
                      onChange={(e) => setForm({ ...form, targetId: e.target.value })}
                      placeholder="Plan ID or resource ID"
                      className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-border-subtle text-sm text-text-main"
                      disabled={editingProduct && editingProduct.source !== "local"}
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
                  <button type="button" onClick={() => { setShowForm(false); setEditingProduct(null); }} className="px-4 py-2 text-sm text-text-muted hover:text-text-main">
                    Cancel
                  </button>
                  <button type="submit" disabled={saving} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                    {saving ? "Saving..." : (editingProduct ? "Update Product" : "Create Product")}
                  </button>
                </div>
              </form>
            </Card>
          )}

          {loading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-16 rounded-lg bg-surface-2 animate-pulse" />)}</div>
          ) : products.length === 0 ? (
            <Card><div className="p-8 text-center text-text-muted">Chưa có sản phẩm nào.</div></Card>
          ) : role === "user" ? (
            /* User Catalog Grid */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {products.map((p) => {
                const canAfford = balance >= p.priceCredits;
                const isOutOfStock = p.stock !== null && p.stock <= 0;
                return (
                  <Card key={p.id} className="p-4 flex flex-col justify-between h-48 border border-border-subtle bg-surface-1 hover:shadow-md transition-shadow">
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-semibold text-text-main text-sm truncate" title={p.name}>{p.name}</span>
                        <span className="px-2 py-0.5 rounded text-xs bg-surface-2 text-text-muted whitespace-nowrap">{p.kind}</span>
                      </div>
                      <p className="text-xs text-text-muted line-clamp-2 h-8">{p.description || "Không có mô tả."}</p>
                      <div className="font-bold text-lg text-primary">{p.priceCredits.toLocaleString()} credits</div>
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-subtle mt-2">
                      <span className="text-xs text-text-muted">
                        {p.stock !== null ? `Tồn kho: ${p.stock}` : "Tồn kho: Không giới hạn"}
                      </span>
                      {isOutOfStock ? (
                        <button disabled className="px-3 py-1.5 bg-red-500/10 text-red-500 rounded-lg text-xs font-medium">Hết hàng</button>
                      ) : !canAfford ? (
                        <button onClick={() => router.push("/dashboard/credits")} className="px-3 py-1.5 bg-yellow-500/10 text-yellow-600 rounded-lg text-xs font-medium hover:bg-yellow-500/20 transition-colors">
                          Nạp credits
                        </button>
                      ) : (
                        <button onClick={() => setBuyingProduct(p)} className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 transition-colors">
                          Mua ngay
                        </button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          ) : (
            /* Admin list view */
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
                        {p.source !== "local" && (
                          <>
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${p.isPublished ? "bg-blue-500/10 text-blue-600" : "bg-yellow-500/10 text-yellow-600"}`}>
                              {p.isPublished ? "Published" : "Draft"}
                            </span>
                            <span className="px-2 py-0.5 rounded text-xs bg-blue-500/10 text-blue-600">external</span>
                          </>
                        )}
                        <span className="px-2 py-0.5 rounded text-xs bg-surface-2 text-text-muted">{p.kind}</span>
                      </div>
                      <div className="text-xs text-text-muted mt-1">
                        {(p.priceCredits ?? 0).toLocaleString()} credits
                        {p.supplierPrice !== null && ` (Supplier: ${p.supplierPrice} credits)`}
                        {` · ${p.deliveryMode}`}
                        {p.stock !== null && ` · stock: ${p.stock}`}
                        {p.description && ` · ${p.description}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Publish / Unpublish action for external products */}
                      {p.source !== "local" && (
                        <button
                          onClick={() => publishAction(p.id, !p.isPublished)}
                          className={`px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                            p.isPublished
                              ? "border-yellow-500/20 text-yellow-600 hover:bg-yellow-500/10"
                              : "border-green-500/20 text-green-600 hover:bg-green-500/10"
                          }`}
                          title={p.isPublished ? "Unpublish (Hạ xuống)" : "Publish (Duyệt bán)"}
                        >
                          {p.isPublished ? "Unpublish" : "Publish"}
                        </button>
                      )}

                      {/* Edit button */}
                      <button
                        onClick={() => startEdit(p)}
                        className="p-1.5 rounded-lg hover:bg-surface-2 text-text-muted hover:text-text-main transition-colors"
                        title="Edit (Sửa)"
                      >
                        <span className="material-symbols-outlined text-[18px]">edit</span>
                      </button>

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
            <Card><div className="p-8 text-center text-text-muted">Chưa có đơn hàng nào.</div></Card>
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
                        {role === "admin" && `User: ${o.userId?.slice(0, 8)} · `}
                        {o.totalCredits?.toLocaleString()} credits · {new Date(o.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    {role === "admin" && o.status === "paid" && (
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
