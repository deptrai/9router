"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button } from "@/shared/components";

function BalanceBadge({ balance }) {
  const val = typeof balance === "number" ? balance : 0;
  const color = val > 1 ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
    : val <= 0 ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
    : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400";
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${color}`}>${val.toFixed(4)}</span>;
}

function formatExpiry(value) {
  if (!value) return "No expiry";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Invalid date";
  return date.toLocaleString();
}

function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function defaultExpiryLocal() {
  return toDateTimeLocal(new Date(Date.now() + 30 * 86400000).toISOString());
}

function PlanBadge({ user }) {
  const plan = user.plan;
  if (!user.planId) return <span className="text-xs text-text-muted">Credit only</span>;
  return (
    <div className="space-y-1">
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${plan?.isActive === false ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"}`}>
        {plan?.displayName || plan?.name || user.planId}{plan?.isActive === false ? " (disabled)" : ""}
      </span>
      <p className="text-xs text-text-muted">{formatExpiry(user.planExpiresAt)}</p>
    </div>
  );
}

function TopupModal({ user, onClose, onSuccess }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    const parsed = parseFloat(amount);
    if (!Number.isFinite(parsed)) { setError("Enter a valid number (negative to deduct)"); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/users/${user.id}/credits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: parsed, note: note.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "Failed to update credits");
      else { onSuccess(user.id, data.newBalance); onClose(); }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-bg-main border border-border-subtle rounded-xl shadow-xl p-6 w-full max-w-sm">
        <h2 className="text-lg font-semibold text-text-main mb-1">Top Up Credits</h2>
        <p className="text-sm text-text-muted mb-4">{user.email}</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-text-main">Amount (USD) — negative to deduct
            <input type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 5.00" className="mt-1 w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50" autoFocus />
          </label>
          <label className="block text-sm font-medium text-text-main">Note
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Admin reason" className="mt-1 w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={loading} icon="paid">Confirm</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AssignPlanModal({ user, plans, onClose, onSuccess }) {
  const [planId, setPlanId] = useState(user.planId || "");
  const [expiresAt, setExpiresAt] = useState(toDateTimeLocal(user.planExpiresAt) || (user.planId ? defaultExpiryLocal() : ""));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const activePlans = plans.filter((plan) => plan.isActive);

  const setShortcut = (days) => {
    const date = new Date(Date.now() + days * 86400000);
    setExpiresAt(toDateTimeLocal(date.toISOString()));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    let expiry = null;
    if (planId && expiresAt) {
      const date = new Date(expiresAt);
      if (!Number.isFinite(date.getTime())) {
        setError("Expiry must be a valid date or blank for no expiry");
        setLoading(false);
        return;
      }
      expiry = date.toISOString();
    }
    try {
      const res = await fetch(`/api/users/${user.id}/plan`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: planId || null, planExpiresAt: planId ? expiry : null }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "Failed to update plan");
      else { onSuccess(data.user); onClose(); }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-bg-main border border-border-subtle rounded-xl shadow-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold text-text-main mb-1">Assign Plan</h2>
        <p className="text-sm text-text-muted mb-4">{user.email}</p>
        <div className="mb-4 rounded-lg bg-surface-2 p-3 text-sm text-text-muted">
          Current: <span className="text-text-main font-medium">{user.plan?.displayName || user.plan?.name || "Credit only"}</span> • {formatExpiry(user.planExpiresAt)}
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-text-main">Plan
            <select value={planId} onChange={(e) => { setPlanId(e.target.value); if (e.target.value && !expiresAt) setExpiresAt(defaultExpiryLocal()); }} className="mt-1 w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main">
              <option value="">No plan / credit only</option>
              {activePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.displayName || plan.name}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-text-main">Expiry
            <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} disabled={!planId} className="mt-1 w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main disabled:opacity-60" />
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={!planId} onClick={() => setShortcut(30)}>+30d</Button>
            <Button type="button" size="sm" variant="secondary" disabled={!planId} onClick={() => setShortcut(365)}>+1y</Button>
            <Button type="button" size="sm" variant="ghost" disabled={!planId} onClick={() => setExpiresAt("")}>No expiry</Button>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={loading} icon="workspace_premium">Save</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [topupUser, setTopupUser] = useState(null);
  const [planUser, setPlanUser] = useState(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [usersRes, plansRes] = await Promise.all([fetch("/api/users"), fetch("/api/plans")]);
      if (!usersRes.ok) {
        setError(usersRes.status === 403 ? "Access denied — admin only." : "Failed to load users.");
        setLoading(false);
        return;
      }
      const usersData = await usersRes.json();
      setUsers(usersData.users || []);
      if (plansRes.ok) {
        const plansData = await plansRes.json();
        setPlans(plansData.plans || []);
      }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(loadUsers, 0);
    return () => clearTimeout(timer);
  }, [loadUsers]);

  const handleTopupSuccess = (userId, newBalance) => {
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, creditsBalance: newBalance } : u)));
  };

  const handlePlanSuccess = (updatedUser) => {
    setUsers((prev) => prev.map((u) => (u.id === updatedUser.id ? updatedUser : u)));
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-main">Users</h1>
        <Button variant="secondary" icon="refresh" onClick={loadUsers}>Refresh</Button>
      </div>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-12 bg-surface-2 animate-pulse rounded" />)}</div>
        ) : error ? (
          <div className="p-6 text-center text-red-500 text-sm">{error}</div>
        ) : users.length === 0 ? (
          <div className="p-6 text-center text-text-muted text-sm">No users found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 border-b border-border-subtle">
                <tr className="text-left text-text-muted text-xs uppercase tracking-wider">
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3 text-center">Overflow</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-surface-2/50 transition-colors">
                    <td className="px-4 py-3 text-text-main font-medium whitespace-nowrap">{user.email}</td>
                    <td className="px-4 py-3 text-text-muted">{user.displayName || "—"}</td>
                    <td className="px-4 py-3"><PlanBadge user={user} /></td>
                    <td className="px-4 py-3 text-center"><span className="text-xs font-semibold text-text-main">{user.allowCreditOverflow ? "ON" : "OFF"}</span></td>
                    <td className="px-4 py-3 text-right"><BalanceBadge balance={user.creditsBalance} /></td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${user.isActive ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"}`}>
                        {user.isActive ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        <Button size="sm" variant="secondary" icon="workspace_premium" onClick={() => setPlanUser(user)}>Plan</Button>
                        <Button size="sm" icon="paid" onClick={() => setTopupUser(user)}>Topup</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {topupUser && <TopupModal user={topupUser} onClose={() => setTopupUser(null)} onSuccess={handleTopupSuccess} />}
      {planUser && <AssignPlanModal user={planUser} plans={plans} onClose={() => setPlanUser(null)} onSuccess={handlePlanSuccess} />}
    </div>
  );
}
