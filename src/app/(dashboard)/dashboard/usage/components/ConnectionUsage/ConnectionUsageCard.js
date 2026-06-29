"use client";

import { useState } from "react";
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n) {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export default function ConnectionUsageCard({ connection, onRefresh }) {
  const [stats, setStats] = useState(null);
  const [upstream, setUpstream] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const providerConfig = AI_PROVIDERS[connection.provider] || {};
  const providerColor = providerConfig.color || "#6B7280";

  const fetchStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/usage/connection/${connection.id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setStats(data.stats);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchUpstream = async () => {
    try {
      const res = await fetch(`/api/usage/${connection.id}`);
      if (res.ok) {
        const data = await res.json();
        setUpstream(data);
      }
    } catch {
      // fail-open — upstream quota là optional
    }
  };

  const handleRefresh = async () => {
    await Promise.all([fetchStats(), fetchUpstream()]);
    onRefresh?.();
  };

  // Fetch lần đầu khi mount
  useState(() => {
    fetchStats();
    fetchUpstream();
  });

  const today = stats?.today || { requests: 0, tokens: 0, cost: 0 };
  const last7d = stats?.last7d || { requests: 0, tokens: 0, cost: 0 };
  const perModel = stats?.perModel || [];

  return (
    <Card padding="md" className="flex flex-col gap-4">
      {/* Header — tên account + provider badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="size-10 rounded-lg flex items-center justify-center p-1.5 shrink-0"
            style={{ backgroundColor: `${providerColor}15` }}
          >
            <ProviderIcon
              src={`/providers/${connection.provider}.png`}
              alt={connection.provider}
              size={40}
              className="object-contain rounded-lg"
              fallbackText={connection.provider?.slice(0, 2).toUpperCase() || "PR"}
              fallbackColor={providerColor}
            />
          </div>
          <div className="min-w-0">
            <h3 className="text-text-main font-semibold truncate">
              {connection.name || connection.email || connection.id.slice(0, 8)}
            </h3>
            <p className="text-xs text-text-muted capitalize">
              {providerConfig.name || connection.provider}
            </p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="shrink-0 p-2 rounded-lg hover:bg-surface-2 transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <span className={`material-symbols-outlined text-[20px] text-text-muted ${loading ? "animate-spin" : ""}`}>
            refresh
          </span>
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="text-sm text-red-500 bg-red-500/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Stats grid — today + 7d */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-bg p-3">
          <p className="text-xs text-text-muted mb-1">Today</p>
          <div className="space-y-0.5">
            <p className="text-sm text-text-main">
              <span className="font-semibold">{today.requests}</span> requests
            </p>
            <p className="text-sm text-text-main">
              <span className="font-semibold">{formatTokens(today.tokens)}</span> tokens
            </p>
            <p className="text-sm text-text-main">
              <span className="font-semibold">{formatCost(today.cost)}</span>
            </p>
          </div>
        </div>
        <div className="rounded-lg bg-bg p-3">
          <p className="text-xs text-text-muted mb-1">Last 7 days</p>
          <div className="space-y-0.5">
            <p className="text-sm text-text-main">
              <span className="font-semibold">{last7d.requests}</span> requests
            </p>
            <p className="text-sm text-text-main">
              <span className="font-semibold">{formatTokens(last7d.tokens)}</span> tokens
            </p>
            <p className="text-sm text-text-main">
              <span className="font-semibold">{formatCost(last7d.cost)}</span>
            </p>
          </div>
        </div>
      </div>

      {/* Upstream quota message (placeholder — B2 stub) */}
      {upstream?.message && (
        <div className="text-xs text-text-muted bg-bg rounded-lg px-3 py-2">
          {upstream.message}
        </div>
      )}

      {/* Per-model breakdown */}
      {perModel.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
            Top models
          </p>
          {perModel.map((m) => (
            <div key={m.model} className="flex items-center justify-between text-sm">
              <span className="text-text-main truncate">{m.model}</span>
              <span className="text-text-muted shrink-0 ml-2">
                {m.requests} req · {formatTokens(m.tokens)} tok
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
