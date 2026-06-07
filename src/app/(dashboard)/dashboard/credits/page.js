"use client";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/shared/components";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 Days" },
  { value: "30d", label: "30 Days" },
  { value: "60d", label: "60 Days" },
];

const AMOUNT_PRESETS = [5, 10, 25, 50, 100];
const COINS = ["USDT", "USDC"];
const NETWORKS = ["tron", "polygon", "ethereum", "solana"];
const NETWORK_LABELS = { tron: "TRC-20", polygon: "Polygon", ethereum: "ERC-20", solana: "Solana" };

export default function CreditsPage() {
  const [balance, setBalance] = useState(null);
  const [stats, setStats] = useState(null);
  const [period, setPeriod] = useState("30d");
  const [loading, setLoading] = useState(true);
  const [isEmailVerified, setIsEmailVerified] = useState(false);

  // Crypto topup state
  const [topupAmount, setTopupAmount] = useState(10);
  const [topupCoin, setTopupCoin] = useState("USDT");
  const [topupNetwork, setTopupNetwork] = useState("tron");
  const [topupLoading, setTopupLoading] = useState(false);
  const [topupError, setTopupError] = useState("");
  const [activePayment, setActivePayment] = useState(null); // {paymentId, paymentUrl, ...}
  const [bonusPercent, setBonusPercent] = useState(15);

  // Payment history
  const [payments, setPayments] = useState([]);

  useEffect(() => {
    async function load() {
      try {
        const statusRes = await fetch("/api/auth/status");
        if (statusRes.ok) {
          const status = await statusRes.json();
          setBalance(status.creditsBalance ?? null);
          setIsEmailVerified(!!status.isEmailVerified);
        }
      } catch {}
      // Load payment history
      try {
        const res = await fetch("/api/payments?limit=10");
        if (res.ok) setPayments(await res.json());
      } catch {}
    }
    load();
  }, []);

  // Poll active payment status
  useEffect(() => {
    if (!activePayment?.paymentId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/payments/${activePayment.paymentId}`);
        if (!res.ok) return;
        const data = await res.json();
        setActivePayment((prev) => ({ ...prev, ...data }));
        if (["settled", "expired", "failed"].includes(data.status)) {
          clearInterval(interval);
          if (data.status === "settled") {
            // Refresh balance + history
            const statusRes = await fetch("/api/auth/status");
            if (statusRes.ok) { const s = await statusRes.json(); setBalance(s.creditsBalance ?? null); }
            const hRes = await fetch("/api/payments?limit=10");
            if (hRes.ok) setPayments(await hRes.json());
          }
        }
      } catch {}
    }, 5000);
    return () => clearInterval(interval);
  }, [activePayment?.paymentId]);

  const handleTopup = useCallback(async () => {
    setTopupLoading(true);
    setTopupError("");
    try {
      const res = await fetch("/api/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: topupAmount, coin: topupCoin, network: topupNetwork }),
      });
      const data = await res.json();
      if (!res.ok) { setTopupError(data.error || "Failed"); return; }
      setActivePayment({ ...data, status: "pending" });
    } catch (e) { setTopupError(e.message); }
    finally { setTopupLoading(false); }
  }, [topupAmount, topupCoin, topupNetwork]);

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

      {/* Crypto Topup Section */}
      <Card className="p-5">
        <p className="text-sm font-semibold text-text-main mb-1">Top up with Crypto {bonusPercent > 0 && <span className="text-green-500">(+{bonusPercent}% bonus!)</span>}</p>
        {!isEmailVerified ? (
          <p className="text-sm text-yellow-600 mt-2">⚠️ Verify your email first to enable crypto topup.</p>
        ) : activePayment && !["settled", "expired", "failed"].includes(activePayment.status) ? (
          /* Active payment — show status */
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted uppercase">Status</span>
              <span className="text-sm font-medium">{activePayment.status === "pending" ? "Waiting for payment..." : activePayment.status}</span>
            </div>
            <div className="text-center p-4 bg-surface-2 rounded-lg">
              <p className="text-xs text-text-muted mb-1">Send exactly {activePayment.amountExpected} {activePayment.coin} ({NETWORK_LABELS[activePayment.network] || activePayment.network}) to:</p>
              {activePayment.payAddress && <p className="font-mono text-xs break-all select-all mt-1">{activePayment.payAddress}</p>}
            </div>
            {activePayment.paymentUrl && (
              <a href={activePayment.paymentUrl} target="_blank" rel="noopener noreferrer" className="block text-center text-sm text-primary hover:underline">
                Open NOWPayments checkout →
              </a>
            )}
            <button onClick={() => setActivePayment(null)} className="w-full text-center text-xs text-text-muted hover:text-text-main mt-2">
              Cancel / Create new
            </button>
          </div>
        ) : activePayment?.status === "settled" ? (
          <div className="mt-3 text-center">
            <p className="text-green-500 font-semibold">✓ Payment confirmed!</p>
            <p className="text-sm text-text-muted">+${activePayment.creditsAwarded?.toFixed(2)} credits added.</p>
            <button onClick={() => setActivePayment(null)} className="mt-2 text-sm text-primary hover:underline">Back</button>
          </div>
        ) : activePayment?.status === "expired" || activePayment?.status === "failed" ? (
          <div className="mt-3 text-center">
            <p className="text-red-500 font-semibold">{activePayment.status === "expired" ? "⏱ Payment expired" : "✕ Payment failed"}</p>
            <button onClick={() => setActivePayment(null)} className="mt-2 text-sm text-primary hover:underline">Try again</button>
          </div>
        ) : (
          /* Topup form */
          <div className="mt-3 space-y-3">
            <div>
              <label className="text-xs text-text-muted">Amount (USD)</label>
              <div className="flex gap-1 mt-1 flex-wrap">
                {AMOUNT_PRESETS.map((a) => (
                  <button key={a} onClick={() => setTopupAmount(a)}
                    className={`px-3 py-1 rounded text-sm ${topupAmount === a ? "bg-primary text-white" : "bg-surface-2 text-text-muted hover:bg-surface-3"}`}
                  >${a}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted">Coin</label>
                <div className="flex gap-1 mt-1">
                  {COINS.map((c) => (
                    <button key={c} onClick={() => setTopupCoin(c)}
                      className={`px-3 py-1 rounded text-sm ${topupCoin === c ? "bg-primary text-white" : "bg-surface-2 text-text-muted hover:bg-surface-3"}`}
                    >{c}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-text-muted">Network</label>
                <div className="flex gap-1 mt-1 flex-wrap">
                  {NETWORKS.map((n) => (
                    <button key={n} onClick={() => setTopupNetwork(n)}
                      className={`px-2 py-1 rounded text-xs ${topupNetwork === n ? "bg-primary text-white" : "bg-surface-2 text-text-muted hover:bg-surface-3"}`}
                    >{NETWORK_LABELS[n]}</button>
                  ))}
                </div>
              </div>
            </div>
            {bonusPercent > 0 && (
              <p className="text-sm text-text-muted">You&apos;ll receive: <span className="font-medium text-green-500">${(topupAmount * (1 + bonusPercent / 100)).toFixed(2)}</span> credits</p>
            )}
            {topupError && <p className="text-sm text-red-500">{topupError}</p>}
            <button onClick={handleTopup} disabled={topupLoading}
              className="w-full py-2 rounded bg-primary text-white font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {topupLoading ? "Creating..." : "Pay with Crypto →"}
            </button>
          </div>
        )}
      </Card>

      {/* Payment History */}
      {payments.length > 0 && (
        <Card className="p-5">
          <p className="text-sm font-semibold text-text-main mb-3">Payment History</p>
          <div className="space-y-2">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm py-1 border-b border-border-subtle last:border-0">
                <span className="text-text-muted">
                  ${p.amountExpected} {p.coin} ({NETWORK_LABELS[p.network] || p.network})
                </span>
                <span className={`font-medium ${p.status === "settled" ? "text-green-500" : p.status === "failed" || p.status === "expired" ? "text-red-400" : "text-yellow-500"}`}>
                  {p.status === "settled" ? `+$${p.creditsAwarded?.toFixed(2)} ✓` : p.status}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

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
