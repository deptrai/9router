"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

function formatMoney(value) {
  return `$${(Number(value) || 0).toFixed(4)}`;
}

function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatDate(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "—";
}

function formatResetCountdown(resetAt) {
  if (!resetAt) return "";
  const diff = new Date(resetAt).getTime() - Date.now();
  if (diff <= 0) return "resetting...";
  const totalMins = Math.ceil(diff / 60000);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return hrs > 0 ? `reset after ${hrs}h ${mins}m` : `reset after ${mins}m`;
}

function WindowBar({ label, limit, consumed, resetAt }) {
  const pct = limit > 0 ? Math.min(100, Math.round((consumed / limit) * 100)) : 0;
  const tone = pct >= 100 ? "bg-red-500" : pct > 80 ? "bg-amber-500" : "bg-primary";
  if (!limit) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-muted">{label}</span>
          <span className="font-medium text-text-main">Unlimited</span>
        </div>
        <div className="text-xs text-text-muted">No quota cap for this window.</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-muted">{label}</span>
        <span className="font-medium text-text-main">{formatTokens(consumed)} / {formatTokens(limit)} tokens</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>{pct}% used</span>
        <span>{formatResetCountdown(resetAt)}</span>
      </div>
    </div>
  );
}

function typeLabel(type) {
  if (type === "usage_deduction") return "Usage";
  if (type === "admin_topup") return "Top-up";
  if (type === "gift_code") return "Gift";
  if (type === "user_payment") return "Payment";
  if (type === "plan_activation") return "Plan activation";
  if (type === "reversal") return "Reversal";
  return type?.replaceAll("_", " ") || "Transaction";
}

export default function PlanPage() {
  const router = useRouter();
  const [role, setRole] = useState(null);
  const [quota, setQuota] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [ledgerHasMore, setLedgerHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [plans, setPlans] = useState([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState("");
  const [purchaseBusy, setPurchaseBusy] = useState("");
  const [purchaseMessage, setPurchaseMessage] = useState("");
  const [overflowSaving, setOverflowSaving] = useState(false);
  const [error, setError] = useState("");
  const [ledgerError, setLedgerError] = useState("");

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        const nextRole = data?.role ?? null;
        setRole(nextRole);
        if (nextRole !== "user") router.replace("/dashboard/credits");
      })
      .catch(() => router.replace("/dashboard/credits"));
  }, [router]);

  const loadQuota = useCallback(async () => {
    try {
      const res = await fetch("/api/users/me/quota");
      if (!res.ok) throw new Error("quota load failed");
      setQuota(await res.json());
    } catch {
      setError("Không tải được hạn mức, thử lại.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLedger = useCallback(async (offset = 0, append = false) => {
    setLedgerLoading(true);
    try {
      const res = await fetch(`/api/users/me/ledger?limit=20&offset=${offset}`);
      if (!res.ok) throw new Error("ledger load failed");
      const data = await res.json();
      const rows = data.transactions || [];
      setLedger((prev) => (append ? [...prev, ...rows] : rows));
      setLedgerHasMore(rows.length === 20);
      setLedgerOffset(offset + rows.length);
    } catch {
      setLedgerError("Không tải được lịch sử giao dịch.");
    } finally {
      setLedgerLoading(false);
    }
  }, []);

  const loadPlans = useCallback(async () => {
    setPlansLoading(true);
    setPlansError("");
    try {
      const res = await fetch("/api/users/me/plans");
      if (!res.ok) throw new Error("plans load failed");
      const data = await res.json();
      setPlans(data.plans || []);
      if (data.creditsBalance !== undefined) setQuota((prev) => prev ? { ...prev, creditsBalance: data.creditsBalance } : prev);
    } catch {
      setPlansError("Không tải được danh sách plan.");
    } finally {
      setPlansLoading(false);
    }
  }, []);

  useEffect(() => {
    if (role !== "user") return;
    const timer = setTimeout(() => {
      loadQuota();
      loadLedger(0, false);
      loadPlans();
    }, 0);
    return () => clearTimeout(timer);
  }, [role, loadQuota, loadLedger, loadPlans]);

  const handlePurchase = useCallback(async (planId) => {
    const idempotencyKey = (globalThis.crypto?.randomUUID?.() || `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setPurchaseBusy(planId);
    setPurchaseMessage("");
    try {
      const res = await fetch("/api/users/me/plan/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, idempotencyKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 402) {
          setPurchaseMessage(`Cần ${formatMoney(data.requiredCredits)} để mua plan này.`);
        } else {
          setPurchaseMessage(data.error || "Mua plan thất bại.");
        }
        return;
      }
      setPurchaseMessage(`Đã ${data.action === "change" ? "đổi" : data.action === "renew" ? "gia hạn" : "mua"} plan thành công.`);
      await Promise.all([loadQuota(), loadLedger(0, false), loadPlans()]);
    } catch {
      setPurchaseMessage("Mua plan thất bại.");
    } finally {
      setPurchaseBusy("");
    }
  }, [loadLedger, loadPlans, loadQuota]);

  const handleToggle = useCallback(async () => {
    if (!quota || quota.source !== "plan") return;
    setOverflowSaving(true);
    const next = !quota.allowCreditOverflow;
    setQuota((prev) => prev ? { ...prev, allowCreditOverflow: next } : prev);
    try {
      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowCreditOverflow: next }),
      });
      if (!res.ok) throw new Error("toggle failed");
      const data = await res.json();
      setQuota((prev) => prev ? { ...prev, allowCreditOverflow: !!data.allowCreditOverflow } : prev);
      loadQuota();
    } catch {
      setQuota((prev) => prev ? { ...prev, allowCreditOverflow: !next } : prev);
    } finally {
      setOverflowSaving(false);
    }
  }, [quota, loadQuota]);

  const ledgerRows = useMemo(() => ledger.map((row) => ({
    ...row,
    label: typeLabel(row.type),
    isOverflow: String(row.note || "").includes("[overflow]"),
  })), [ledger]);

  if (role === null) {
    return <div className="p-6 max-w-5xl mx-auto text-sm text-text-muted">Loading...</div>;
  }
  if (role !== "user") return null;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-main">Plan & Quota</h1>
        <p className="text-sm text-text-muted">Giới hạn gói, credit, ledger, overflow toggle.</p>
      </div>

      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Plan</p>
            <h2 className="text-lg font-semibold text-text-main">
              {loading ? "Loading..." : quota?.planName || "Pay-as-you-go (credit)"}
            </h2>
            <p className="text-sm text-text-muted">
              {quota?.planExpiresAt ? `Expires ${formatDate(quota.planExpiresAt)}` : quota?.source === "plan" ? "Active" : "No plan"}
            </p>
          </div>
          <div className="rounded-full bg-surface-2 px-3 py-1 text-xs font-semibold text-text-muted uppercase">
            {quota?.source || "..."}
          </div>
        </div>

        {error ? <p className="text-sm text-red-500">{error}</p> : null}

        {quota?.source === "plan" ? (
          <div className="space-y-4">
            <WindowBar label="5h quota" limit={quota.quota5h?.limit || 0} consumed={quota.quota5h?.consumed || 0} resetAt={quota.quota5h?.resetAt} />
            <WindowBar label="Weekly quota" limit={quota.quotaWeekly?.limit || 0} consumed={quota.quotaWeekly?.consumed || 0} resetAt={quota.quotaWeekly?.resetAt} />
            {quota.perModel ? (
              <div className="rounded-lg border border-border-subtle bg-surface-1 p-4 space-y-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Per-model override</p>
                  <p className="text-sm font-medium text-text-main">{quota.model}</p>
                </div>
                <WindowBar label="Model 5h quota" limit={quota.perModel.quota5h?.limit || 0} consumed={quota.perModel.quota5h?.consumed || 0} resetAt={quota.perModel.quota5h?.resetAt} />
                <WindowBar label="Model weekly quota" limit={quota.perModel.quotaWeekly?.limit || 0} consumed={quota.perModel.quotaWeekly?.consumed || 0} resetAt={quota.perModel.quotaWeekly?.resetAt} />
              </div>
            ) : null}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg bg-surface-2 p-4">
                <p className="text-xs uppercase tracking-wider text-text-muted mb-1">RPM</p>
                <p className="font-semibold text-text-main">{quota.rpmUsed || 0} / {quota.rpm || 0} req/min</p>
              </div>
              <div className="rounded-lg bg-surface-2 p-4">
                <p className="text-xs uppercase tracking-wider text-text-muted mb-1">Credit balance</p>
                <p className="font-semibold text-text-main">{formatMoney(quota.creditsBalance)}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg bg-surface-2 p-4 text-sm text-text-muted">
            Pay-as-you-go (credit). No quota bars for this account.
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Plans</p>
            <h3 className="text-lg font-semibold text-text-main">Active catalog</h3>
          </div>
          <Link href="/dashboard/credits" className="text-sm text-primary hover:underline">Top up credits</Link>
        </div>
        {plansError ? <p className="text-sm text-red-500">{plansError}</p> : null}
        {purchaseMessage ? <p className="text-sm text-text-muted">{purchaseMessage}</p> : null}
        {plansLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[1, 2].map((i) => <div key={i} className="h-28 rounded-lg bg-surface-2 animate-pulse" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {plans.map((plan) => (
              <div key={plan.id} className="rounded-lg border border-border-subtle bg-surface-1 p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-text-main">{plan.displayName || plan.name}</p>
                    <p className="text-xs text-text-muted">{plan.name}</p>
                  </div>
                  <p className="text-sm font-semibold text-text-main">{Number(plan.priceCredits || 0).toLocaleString()} credits</p>
                </div>
                <p className="text-sm text-text-muted">{plan.durationDays || 30} days • RPM {formatTokens(plan.rpm)} • 5h {formatTokens(plan.quota5h)} • weekly {formatTokens(plan.quotaWeekly)}</p>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-text-muted">{plan.canAfford ? "Affordable" : "Needs top-up"} • {plan.action}</span>
                  <button
                    type="button"
                    onClick={() => handlePurchase(plan.id)}
                    disabled={purchaseBusy === plan.id || !plan.canAfford}
                    className="inline-flex min-w-24 items-center justify-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
                  >
                    {purchaseBusy === plan.id ? "Working..." : plan.action === "renew" ? "Renew" : plan.action === "change" ? "Change" : "Buy"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Overflow</p>
            <h3 className="text-lg font-semibold text-text-main">allowCreditOverflow</h3>
            <p className="text-sm text-text-muted">Bật = tiếp tục bằng credit khi quota cạn; tắt = chặn request. Chỉ áp dụng khi có gói.</p>
          </div>
          <button
            type="button"
            onClick={handleToggle}
            disabled={overflowSaving || quota?.source !== "plan"}
            className={cn(
              "inline-flex items-center rounded-full px-4 py-2 text-sm font-medium transition-colors",
              quota?.allowCreditOverflow ? "bg-primary text-white" : "bg-surface-2 text-text-main",
              (overflowSaving || quota?.source !== "plan") && "opacity-60 cursor-not-allowed"
            )}
          >
            {quota?.allowCreditOverflow ? "On" : "Off"}
          </button>
        </div>
      </Card>

      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Ledger</p>
            <h3 className="text-lg font-semibold text-text-main">Credit history</h3>
          </div>
          <button
            type="button"
            onClick={() => loadLedger(ledgerOffset, true)}
            disabled={ledgerLoading || !ledgerHasMore}
            className="rounded-lg bg-surface-2 px-3 py-2 text-sm font-medium text-text-main disabled:opacity-60"
          >
            {ledgerLoading ? "Loading..." : ledgerHasMore ? "Load more" : "No more"}
          </button>
        </div>

        {ledgerError ? <p className="text-sm text-red-500">{ledgerError}</p> : null}

        {ledgerRows.length === 0 && !ledgerLoading ? (
          <p className="py-6 text-sm text-text-muted text-center">No ledger entries yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border-subtle">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Note</th>
                </tr>
              </thead>
              <tbody>
                {ledgerRows.map((row) => (
                  <tr key={row.id} className="border-t border-border-subtle">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-main">{row.label}</span>
                        {row.isOverflow ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600">Overflow</span> : null}
                      </div>
                    </td>
                    <td className={cn("px-4 py-3 font-medium", (row.amount || 0) < 0 ? "text-red-500" : "text-green-500")}>
                      {row.amount > 0 ? "+" : ""}{formatMoney(row.amount)}
                    </td>
                    <td className="px-4 py-3 text-text-muted">{formatDate(row.createdAt)}</td>
                    <td className="px-4 py-3 text-text-muted">{row.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="text-sm text-text-muted">
        <Link href="/dashboard/credits" className="text-primary hover:underline">View credits</Link>
      </div>
    </div>
  );
}
