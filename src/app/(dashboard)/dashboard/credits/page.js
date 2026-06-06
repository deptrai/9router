"use client";

import { useState, useEffect } from "react";
import { Card } from "@/shared/components";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 Days" },
  { value: "30d", label: "30 Days" },
  { value: "60d", label: "60 Days" },
];

export default function CreditsPage() {
  const [balance, setBalance] = useState(null);
  const [stats, setStats] = useState(null);
  const [period, setPeriod] = useState("30d");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const statusRes = await fetch("/api/auth/status");
        if (statusRes.ok) {
          const status = await statusRes.json();
          setBalance(status.creditsBalance ?? null);
        }
      } catch {}
    }
    load();
  }, []);

  useEffect(() => {
    async function loadStats() {
      setLoading(true);
      try {
        const res = await fetch(`/api/usage/stats?period=${period}`);
        if (res.ok) {
          const data = await res.json();
          setStats(data);
        }
      } catch {}
      setLoading(false);
    }
    loadStats();
  }, [period]);

  // Aggregate by model from byApiKey entries
  const modelRows = stats
    ? Object.values(
        Object.values(stats.byApiKey || {}).reduce((acc, entry) => {
          const key = `${entry.rawModel}|${entry.provider || ""}`;
          if (!acc[key]) {
            acc[key] = { model: entry.rawModel, provider: entry.provider || "", requests: 0, cost: 0 };
          }
          acc[key].requests += entry.requests || 0;
          acc[key].cost += entry.cost || 0;
          return acc;
        }, {})
      ).sort((a, b) => b.cost - a.cost)
    : [];

  const totalCost = stats?.totalCost ?? 0;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold text-text-main">Credits</h1>

      {/* Balance card */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card className="p-5">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Current Balance</p>
          {balance === null ? (
            <div className="h-8 w-24 bg-surface-2 animate-pulse rounded" />
          ) : (
            <>
              <p className={`text-3xl font-bold ${balance <= 0 ? "text-red-500" : "text-green-500"}`}>
                ${typeof balance === "number" ? balance.toFixed(4) : "0.0000"}
              </p>
              {balance <= 0 && (
                <p className="mt-2 text-sm text-red-500 font-medium">
                  ⚠️ Insufficient credits — contact admin to top up.
                </p>
              )}
            </>
          )}
        </Card>

        <Card className="p-5">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">
            Spent ({PERIODS.find(p => p.value === period)?.label})
          </p>
          {loading ? (
            <div className="h-8 w-24 bg-surface-2 animate-pulse rounded" />
          ) : (
            <p className="text-3xl font-bold text-text-main">${totalCost.toFixed(4)}</p>
          )}
        </Card>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-text-muted">Period:</span>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                period === p.value
                  ? "bg-primary text-white"
                  : "bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text-main"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Usage by model */}
      <Card className="p-5">
        <p className="text-sm font-semibold text-text-main mb-4">Usage by Model</p>
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-surface-2 animate-pulse rounded" />
            ))}
          </div>
        ) : modelRows.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-6">No usage data for this period.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted text-xs uppercase tracking-wider border-b border-border-subtle">
                <th className="pb-2 pr-4">Model</th>
                <th className="pb-2 pr-4">Provider</th>
                <th className="pb-2 pr-4 text-right">Requests</th>
                <th className="pb-2 text-right">Cost (USD)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {modelRows.map((row) => (
                <tr key={`${row.model}|${row.provider}`} className="hover:bg-surface-2/50 transition-colors">
                  <td className="py-2 pr-4 font-mono text-xs text-text-main">{row.model || "—"}</td>
                  <td className="py-2 pr-4 text-text-muted">{row.provider || "—"}</td>
                  <td className="py-2 pr-4 text-right text-text-muted">{row.requests}</td>
                  <td className="py-2 text-right font-medium text-text-main">${row.cost.toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border-subtle">
                <td colSpan={3} className="pt-2 text-xs font-semibold text-text-muted uppercase">Total</td>
                <td className="pt-2 text-right font-bold text-text-main">${totalCost.toFixed(6)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>
    </div>
  );
}
