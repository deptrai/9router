"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/shared/components";

export default function GiftCodesPage() {
  const router = useRouter();
  const [role, setRole] = useState(null); // null = loading
  const [giftCodes, setGiftCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ code: "", creditsAmount: "", maxRedemptions: "", expiresAt: "", note: "" });
  const [saving, setSaving] = useState(false);

  // Role guard: this is an admin-only page. role=user → redirect to Credits.
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

  const loadGiftCodes = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/gift-codes");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to load gift codes");
      } else {
        setGiftCodes(data.giftCodes || []);
      }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (role === "admin") loadGiftCodes(); }, [role, loadGiftCodes]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        code: form.code || undefined,
        creditsAmount: Number(form.creditsAmount),
        maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : undefined,
        expiresAt: form.expiresAt || undefined,
        note: form.note || undefined,
      };
      const res = await fetch("/api/gift-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to create gift code");
      } else {
        setForm({ code: "", creditsAmount: "", maxRedemptions: "", expiresAt: "", note: "" });
        await loadGiftCodes();
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  const disableCode = async (id) => {
    await fetch(`/api/gift-codes/${id}`, { method: "DELETE" });
    await loadGiftCodes();
  };

  // Show skeleton while role check is pending; if user, redirect already in flight
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
        <h1 className="text-2xl font-semibold text-text-main">Gift Codes</h1>
        <button onClick={loadGiftCodes} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-surface-2 text-text-muted hover:bg-surface-3 transition-colors">
          Refresh
        </button>
      </div>

      <Card className="p-5">
        <h2 className="text-lg font-semibold text-text-main mb-4">Create Gift Code</h2>
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <input className="px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main" placeholder="Code (optional)" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
          <input className="px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main" placeholder="Credits amount" value={form.creditsAmount} onChange={(e) => setForm((f) => ({ ...f, creditsAmount: e.target.value }))} />
          <input className="px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main" placeholder="Max redemptions" value={form.maxRedemptions} onChange={(e) => setForm((f) => ({ ...f, maxRedemptions: e.target.value }))} />
          <input type="datetime-local" className="px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main" value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} />
          <input className="md:col-span-2 px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main" placeholder="Note" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          {error && <p className="md:col-span-2 text-sm text-red-500">{error}</p>}
          <div className="md:col-span-2 flex justify-end">
            <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium disabled:opacity-60">{saving ? "Saving…" : "Create"}</button>
          </div>
        </form>
      </Card>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 text-sm text-text-muted">Loading…</div>
        ) : giftCodes.length === 0 ? (
          <div className="p-6 text-sm text-text-muted">No gift codes found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-border-subtle">
              <tr className="text-left text-xs uppercase tracking-wider text-text-muted">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Credits</th>
                <th className="px-4 py-3">Redeemed</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {giftCodes.map((gc) => (
                <tr key={gc.id} className="hover:bg-surface-2/50">
                  <td className="px-4 py-3 font-medium text-text-main">{gc.code}</td>
                  <td className="px-4 py-3 text-text-muted">{gc.creditsAmount}</td>
                  <td className="px-4 py-3 text-text-muted">{gc.redeemedCount}{gc.maxRedemptions ? ` / ${gc.maxRedemptions}` : ""}</td>
                  <td className="px-4 py-3 text-text-muted">{gc.isActive ? (gc.expiresAt && new Date(gc.expiresAt) < new Date() ? "Expired" : "Active") : "Inactive"}</td>
                  <td className="px-4 py-3 text-right"><button onClick={() => disableCode(gc.id)} className="px-3 py-1 rounded-lg text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20">Disable</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
