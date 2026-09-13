'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart3,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Wallet,
  RotateCcw,
  ShoppingCart,
  Activity,
} from 'lucide-react';
import type {
  AdminFinanceSummaryDto,
  AdminRevenueMetricDto,
  AdminLedgerIntegrityDto,
} from '@repo/shared-types';
import { apiClient } from '../../lib/api-client';
import { formatVnd, formatCompactVnd, formatDate } from '../../lib/formatters';
import { useToast } from '../../components/Toast';

type Granularity = 'daily' | 'weekly' | 'monthly';

export default function AdminFinancePage() {
  const { showToast } = useToast();

  // Reconciliation summary state
  const [summary, setSummary] = useState<AdminFinanceSummaryDto | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  // Revenue metrics state
  const [metrics, setMetrics] = useState<AdminRevenueMetricDto[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [granularity, setGranularity] = useState<Granularity>('daily');

  // Integrity check state
  const [integrity, setIntegrity] = useState<AdminLedgerIntegrityDto | null>(null);
  const [integrityLoading, setIntegrityLoading] = useState(true);

  const fetchSummary = async () => {
    try {
      const res = await apiClient.get<{ ok: boolean; summary: AdminFinanceSummaryDto }>(
        '/api/admin/finance/summary',
      );
      setSummary(res.summary);
    } catch (err: any) {
      showToast(err?.message || 'Không thể tải báo cáo đối soát', 'error');
    } finally {
      setSummaryLoading(false);
    }
  };

  const fetchRevenue = async (gran: Granularity) => {
    setMetricsLoading(true);
    try {
      const res = await apiClient.get<{ ok: boolean; metrics: AdminRevenueMetricDto[] }>(
        `/api/admin/finance/revenue?granularity=${gran}`,
      );
      setMetrics(res.metrics || []);
    } catch (err: any) {
      showToast(err?.message || 'Không thể tải báo cáo doanh thu', 'error');
    } finally {
      setMetricsLoading(false);
    }
  };

  const fetchIntegrity = async () => {
    try {
      const res = await apiClient.get<{ ok: boolean; integrity: AdminLedgerIntegrityDto }>(
        '/api/admin/finance/ledger-check',
      );
      setIntegrity(res.integrity);
    } catch (err: any) {
      showToast(err?.message || 'Không thể tải kiểm tra sổ cái', 'error');
    } finally {
      setIntegrityLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchSummary();
    fetchRevenue(granularity);
    fetchIntegrity();
  }, []);

  // Refetch revenue when granularity changes
  useEffect(() => {
    fetchRevenue(granularity);
  }, [granularity]);

  // Auto-refresh summary every 30s
  useEffect(() => {
    const id = setInterval(() => {
      fetchSummary();
      fetchIntegrity();
    }, 30_000);
    return () => clearInterval(id);
  }, []);



  const delta = summary?.reconciledDelta ?? '0.00';
  const deltaNum = parseFloat(delta);
  const isReconciled = summary?.isReconciled ?? true;
  const violations = integrity?.violations ?? [];

  // Compute chart bounds
  const chartData = useMemo(() => {
    if (metrics.length === 0) return { max: 0, min: 0 };
    const all = metrics.flatMap((m) => [
      parseFloat(m.revenueVnd),
      parseFloat(m.costVnd),
      parseFloat(m.profitVnd),
    ]);
    return {
      max: Math.max(...all, 0),
      min: Math.min(...all, 0),
    };
  }, [metrics]);

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2.5">
            <BarChart3 className="w-6 h-6 text-amber-400" />
            <h1 className="text-2xl font-bold text-slate-100">Báo cáo Tài chính & Đối soát</h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Đối soát Sổ cái — Ví khách — Doanh thu theo thời gian thực
          </p>
        </div>

        <button
          onClick={() => {
            fetchSummary();
            fetchRevenue(granularity);
            fetchIntegrity();
          }}
          title="Làm mới toàn bộ"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 text-xs font-semibold transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${summaryLoading || metricsLoading ? 'animate-spin text-amber-400' : ''}`} />
          <span>Làm mới</span>
        </button>
      </div>

      {/* Reconciliation Status Banner */}
      <div
        className={`mt-6 p-4 rounded-xl border ${
          isReconciled
            ? 'bg-emerald-500/10 border-emerald-500/30'
            : 'bg-rose-500/10 border-rose-500/30'
        }`}
      >
        <div className="flex items-center gap-3">
          {isReconciled ? (
            <>
              <CheckCircle className="w-6 h-6 text-emerald-400" />
              <div>
                <p className="text-sm font-bold text-emerald-400">✓ Đã đối soát chính xác</p>
                <p className="text-[11px] text-emerald-300/80 mt-0.5">
                  Sổ cái và ví khách khớp 100% — chênh lệch {formatVnd(delta)}
                </p>
              </div>
            </>
          ) : (
            <>
              <AlertTriangle className="w-6 h-6 text-rose-400" />
              <div>
                <p className="text-sm font-bold text-rose-400">⚠ Phát hiện chênh lệch đối soát</p>
                <p className="text-[11px] text-rose-300/80 mt-0.5">
                  Chênh lệch {formatVnd(delta)} — cần điều tra giao dịch bất thường bên dưới
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mt-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-sky-400 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider">Tổng nạp</span>
            <Wallet className="w-4 h-4" />
          </div>
          <p className="text-lg font-bold font-mono text-slate-100">
            {formatVnd(summary?.totalDepositsVnd)}
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-rose-400 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider">Tổng mua</span>
            <ShoppingCart className="w-4 h-4" />
          </div>
          <p className="text-lg font-bold font-mono text-slate-100">
            {formatVnd(summary?.totalPurchasesVnd)}
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-emerald-400 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider">Tổng hoàn</span>
            <RotateCcw className="w-4 h-4" />
          </div>
          <p className="text-lg font-bold font-mono text-slate-100">
            {formatVnd(summary?.totalRefundsVnd)}
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-amber-400 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider">Ví khách</span>
            <DollarSign className="w-4 h-4" />
          </div>
          <p className="text-lg font-bold font-mono text-slate-100">
            {formatVnd(summary?.totalWalletLiabilitiesVnd)}
          </p>
        </div>

        <div
          className={`bg-slate-900 border rounded-2xl p-4 ${
            isReconciled ? 'border-slate-800' : 'border-rose-500/30'
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider">Độ lệch</span>
            <Activity className="w-4 h-4" />
          </div>
          <p
            className={`text-lg font-bold font-mono ${
              isReconciled ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {formatVnd(delta)}
          </p>
        </div>
      </div>

      {/* Revenue Chart */}
      <div className="mt-6 bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-slate-200">Doanh thu & Lợi nhuận</h2>
          <div className="flex items-center gap-1.5">
            {(['daily', 'weekly', 'monthly'] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                  granularity === g
                    ? 'bg-amber-500 text-slate-950'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {g === 'daily' ? 'Ngày' : g === 'weekly' ? 'Tuần' : 'Tháng'}
              </button>
            ))}
          </div>
        </div>

        {metricsLoading ? (
          <div className="h-64 flex items-center justify-center text-slate-500 text-xs">
            Đang tải dữ liệu...
          </div>
        ) : metrics.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-slate-500 text-xs">
            Chưa có dữ liệu doanh thu trong khoảng thời gian này.
          </div>
        ) : (
          <SimpleLineChart data={metrics} />
        )}

        {/* Legend */}
        <div className="flex items-center justify-center gap-6 mt-4 text-[11px]">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-emerald-400"></div>
            <span className="text-slate-400">Doanh thu</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-rose-400"></div>
            <span className="text-slate-400">Giá vốn</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-amber-400"></div>
            <span className="text-slate-400">Lợi nhuận</span>
          </div>
        </div>
      </div>

      {/* Integrity Violations Panel */}
      {!integrityLoading && violations.length > 0 && (
        <div className="mt-6 bg-rose-950/20 border border-rose-500/30 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <h2 className="text-sm font-bold text-rose-400">
              Phát hiện {violations.length} vi phạm toàn vẹn sổ cái
            </h2>
          </div>
          <div className="space-y-2">
            {violations.map((v, i) => (
              <div
                key={i}
                className="p-3 rounded-lg bg-slate-900/50 border border-rose-500/20 text-xs"
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      v.severity === 'high'
                        ? 'bg-rose-500/20 text-rose-400'
                        : v.severity === 'medium'
                        ? 'bg-amber-500/20 text-amber-400'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {v.rule}
                  </span>
                  <span className="font-mono text-slate-500 text-[10px]">
                    {v.offendingId.slice(0, 8)}...
                  </span>
                </div>
                <p className="text-slate-300">{v.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Anomalous Transactions Panel */}
      {!isReconciled && summary && summary.anomalousTransactions.length > 0 && (
        <div className="mt-6 bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h2 className="text-sm font-bold text-slate-200 mb-3">
            Giao dịch gần đây cần kiểm tra ({summary.anomalousTransactions.length})
          </h2>
          <div className="divide-y divide-slate-800 text-xs">
            {summary.anomalousTransactions.slice(0, 20).map((tx) => (
              <div key={tx.id} className="py-2 flex items-center justify-between">
                <div>
                  <p className="font-mono text-slate-300">#{tx.id.slice(0, 8)}</p>
                  <p className="text-[10px] text-slate-500">{tx.type}</p>
                </div>
                <div className="text-right">
                  <p
                    className={`font-mono font-bold ${
                      parseFloat(tx.amount) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {formatVnd(tx.amount)}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {formatDate(tx.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * Simple SVG line chart — no external deps.
 * Renders revenue/cost/profit lines with continuous bucket timeline.
 */
function SimpleLineChart({ data }: { data: AdminRevenueMetricDto[] }) {
  const width = 800;
  const height = 240;
  const padLeft = 60;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 30;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;

  const allValues = data.flatMap((d) => [
    parseFloat(d.revenueVnd),
    parseFloat(d.costVnd),
    parseFloat(d.profitVnd),
  ]);
  const maxV = Math.max(...allValues, 0);
  const minV = Math.min(...allValues, 0);
  const range = maxV - minV || 1;

  const xStep = data.length > 1 ? innerWidth / (data.length - 1) : 0;

  const toXY = (v: number, i: number) => {
    // Center single data point in viewport
    const x = data.length === 1 ? padLeft + innerWidth / 2 : padLeft + i * xStep;
    const y = padTop + innerHeight - ((v - minV) / range) * innerHeight;
    return { x, y };
  };

  const lineFor = (key: 'revenueVnd' | 'costVnd' | 'profitVnd') => {
    if (data.length === 1) {
      // Draw short horizontal segment across the centered point for single bucket
      const { x, y } = toXY(parseFloat(data[0][key]), 0);
      return `${x - 20},${y} ${x + 20},${y}`;
    }
    return data
      .map((d, i) => {
        const { x, y } = toXY(parseFloat(d[key]), i);
        return `${x},${y}`;
      })
      .join(' ');
  };



  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => minV + f * range);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-64">
      {/* Grid lines */}
      {yTicks.map((v, i) => {
        const { y } = toXY(v, 0);
        return (
          <g key={i}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={y}
              y2={y}
              stroke="#1e293b"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <text
              x={padLeft - 8}
              y={y + 4}
              textAnchor="end"
              fill="#64748b"
              fontSize={10}
              fontFamily="monospace"
            >
              {formatCompactVnd(v)}
            </text>
          </g>
        );
      })}

      {/* X-axis labels (first, middle, last bucket) */}
      {data.length > 0 && (
        <>
          <text
            x={padLeft}
            y={height - 8}
            fill="#64748b"
            fontSize={10}
            fontFamily="monospace"
          >
            {new Date(data[0].bucket).toLocaleDateString('vi-VN', {
              month: 'short',
              day: 'numeric',
            })}
          </text>
          {data.length > 2 && (
            <text
              x={padLeft + innerWidth / 2}
              y={height - 8}
              textAnchor="middle"
              fill="#64748b"
              fontSize={10}
              fontFamily="monospace"
            >
              {new Date(data[Math.floor(data.length / 2)].bucket).toLocaleDateString('vi-VN', {
                month: 'short',
                day: 'numeric',
              })}
            </text>
          )}
          <text
            x={width - padRight}
            y={height - 8}
            textAnchor="end"
            fill="#64748b"
            fontSize={10}
            fontFamily="monospace"
          >
            {new Date(data[data.length - 1].bucket).toLocaleDateString('vi-VN', {
              month: 'short',
              day: 'numeric',
            })}
          </text>
        </>
      )}

      {/* Lines */}
      <polyline
        fill="none"
        stroke="#34d399"
        strokeWidth={2}
        points={lineFor('revenueVnd')}
      />
      <polyline
        fill="none"
        stroke="#fb7185"
        strokeWidth={2}
        points={lineFor('costVnd')}
      />
      <polyline
        fill="none"
        stroke="#fbbf24"
        strokeWidth={2}
        points={lineFor('profitVnd')}
      />

      {/* Data points for revenue line */}
      {data.map((d, i) => {
        const { x, y } = toXY(parseFloat(d.revenueVnd), i);
        return <circle key={i} cx={x} cy={y} r={3} fill="#34d399" />;
      })}
    </svg>
  );
}
