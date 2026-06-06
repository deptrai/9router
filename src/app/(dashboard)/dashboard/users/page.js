"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button } from "@/shared/components";

function BalanceBadge({ balance }) {
  const val = typeof balance === "number" ? balance : 0;
  const color = val > 1 ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
    : val <= 0 ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
    : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${color}`}>
      ${val.toFixed(4)}
    </span>
  );
}

function TopupModal({ user, onClose, onSuccess }) {
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    const parsed = parseFloat(amount);
    if (!Number.isFinite(parsed)) {
      setError("Enter a valid number (negative to deduct)");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/users/${user.id}/credits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: parsed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to update credits");
      } else {
        onSuccess(user.id, data.newBalance);
        onClose();
      }
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
          <div>
            <label className="block text-sm font-medium text-text-main mb-1">
              Amount (USD) — negative to deduct
            </label>
            <input
              type="number"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 5.00"
              className="w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50"
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-surface-2 text-text-muted hover:bg-surface-3 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-60 transition-colors"
            >
              {loading ? "Saving…" : "Confirm"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [topupUser, setTopupUser] = useState(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/users");
      if (!res.ok) {
        if (res.status === 403) {
          setError("Access denied — admin only.");
        } else {
          setError("Failed to load users.");
        }
        setLoading(false);
        return;
      }
      const data = await res.json();
      setUsers(data.users || []);
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const handleTopupSuccess = (userId, newBalance) => {
    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, creditsBalance: newBalance } : u))
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-main">Users</h1>
        <button
          onClick={loadUsers}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-surface-2 text-text-muted hover:bg-surface-3 transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[16px]">refresh</span>
          Refresh
        </button>
      </div>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 bg-surface-2 animate-pulse rounded" />
            ))}
          </div>
        ) : error ? (
          <div className="p-6 text-center text-red-500 text-sm">{error}</div>
        ) : users.length === 0 ? (
          <div className="p-6 text-center text-text-muted text-sm">No users found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-border-subtle">
              <tr className="text-left text-text-muted text-xs uppercase tracking-wider">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-surface-2/50 transition-colors">
                  <td className="px-4 py-3 text-text-main font-medium">{user.email}</td>
                  <td className="px-4 py-3 text-text-muted">{user.displayName || "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <BalanceBadge balance={user.creditsBalance} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                      user.isActive
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                    }`}>
                      {user.isActive ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setTopupUser(user)}
                      className="px-3 py-1 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      Topup
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {topupUser && (
        <TopupModal
          user={topupUser}
          onClose={() => setTopupUser(null)}
          onSuccess={handleTopupSuccess}
        />
      )}
    </div>
  );
}
