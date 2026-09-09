"use client";

import { useState, useEffect } from "react";
import { Card } from "@/shared/components";

function StatCard({ label, value, sub, color = "text-text-main" }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-text-muted uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-text-muted mt-1">{sub}</p>}
    </Card>
  );
}

function formatCredits(n) {
  if (n == null) return "0";
  return n >= 1000 ? `$${(n).toFixed(0)}` : `$${(n).toFixed(2)}`;
}

export default function AdminOverviewPage() {
  const [data, setData] = useState(null);
  const [payments, setPayments] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/overview").then(r => r.ok ? r.json() : Promise.reject()),
      fetch("/api/admin/payments/summary?period=30d").then(r => r.ok ? r.json() : null),
    ])
      .then(([overview, pmts]) => { setData(overview); setPayments(pmts); })
      .catch(() => setError("Failed to load admin data"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold text-text-main">Admin Overview</h1>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="h-24 bg-surface-2 animate-pulse rounded-xl" />)}
      </div>
    </div>
  );

  if (error) return (
    <div className="p-6 max-w-6xl mx-auto">
      <p className="text-red-500">{error}</p>
    </div>
  );

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold text-text-main">Admin Overview</h1>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <StatCard label="Total Users" value={data.totalUsers} sub={`${data.activeUsers7d} active (7d)`} />
        <StatCard label="Revenue (7d)" value={formatCredits(data.revenue7d)} color="text-green-600 dark:text-green-400" />
        <StatCard label="Revenue (30d)" value={formatCredits(data.revenue30d)} color="text-green-600 dark:text-green-400" />
        <StatCard label="Revenue (All)" value={formatCredits(data.revenueTotal)} color="text-green-600 dark:text-green-400" />
        <StatCard label="Credits In Circulation" value={formatCredits(data.totalCreditsInCirculation)} />
        <StatCard label="Pending Payments" value={data.pendingPaymentsCount} color={data.pendingPaymentsCount > 0 ? "text-yellow-600 dark:text-yellow-400" : "text-text-main"} />
        <StatCard label="Low Balance Users" value={data.lowBalanceUsersCount} sub="balance < $1.00" color={data.lowBalanceUsersCount > 0 ? "text-red-500" : "text-text-main"} />
        <StatCard label="Topups (30d)" value={`${data.topupCountVnd} VND / ${data.topupCountCrypto} Crypto`} />
      </div>

      {payments?.daily?.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-medium text-text-muted mb-3">Revenue (30d) — Daily Settled</h2>
          <div className="flex items-end gap-1 h-32 overflow-x-auto">
            {payments.daily.map((d, i) => {
              const max = Math.max(...payments.daily.map(x => x.credits), 1);
              const h = Math.max((d.credits / max) * 100, 2);
              return (
                <div key={i} className="flex flex-col items-center flex-shrink-0" style={{ width: "16px" }}>
                  <div className="bg-primary/70 rounded-t w-3" style={{ height: `${h}%` }} title={`${d.date}: $${d.credits.toFixed(2)}`} />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-text-muted mt-1">
            <span>{payments.daily[0]?.date}</span>
            <span>{payments.daily[payments.daily.length - 1]?.date}</span>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4">
          <h2 className="text-sm font-medium text-text-muted mb-2">Quick Actions</h2>
          <div className="space-y-2">
            <a href="/dashboard/users" className="block text-sm text-primary hover:underline">Manage Users</a>
            <a href="/dashboard/plans" className="block text-sm text-primary hover:underline">Manage Plans</a>
            <a href="/dashboard/gift-codes" className="block text-sm text-primary hover:underline">Gift Codes</a>
            <a href="/dashboard/store" className="block text-sm text-primary hover:underline">Store Management</a>
          </div>
        </Card>

        {payments?.byStatus && (
          <Card className="p-4">
            <h2 className="text-sm font-medium text-text-muted mb-2">Payments by Status (30d)</h2>
            <div className="space-y-1">
              {Object.entries(payments.byStatus).map(([status, count]) => (
                <div key={status} className="flex justify-between text-sm">
                  <span className="text-text-muted capitalize">{status}</span>
                  <span className="text-text-main font-medium">{count}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
