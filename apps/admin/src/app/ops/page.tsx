'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  RefreshCw,
  AlertTriangle,
  Clock,
  Zap,
  ShieldAlert,
  RotateCcw,
  Timer,
} from 'lucide-react';
import type {
  AdminOpsMetricsDto,
  FailedJobDto,
} from '@repo/shared-types';
import { apiClient } from '../../lib/api-client';
import { useToast } from '../../components/Toast';

const REFRESH_INTERVAL_MS = 30_000;

export default function AdminOpsPage() {
  const { showToast } = useToast();

  const [metrics, setMetrics] = useState<AdminOpsMetricsDto | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);

  const [failedJobs, setFailedJobs] = useState<FailedJobDto[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);

  const [retryingId, setRetryingId] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await apiClient.get<{ ok: boolean; metrics: AdminOpsMetricsDto }>(
        '/api/admin/ops/metrics?windowHours=24',
      );
      setMetrics(res.metrics);
    } catch (err: any) {
      showToast(err?.message || 'Không thể tải chỉ số vận hành', 'error');
    } finally {
      setMetricsLoading(false);
    }
  }, [showToast]);

  const fetchFailedJobs = useCallback(async () => {
    try {
      const res = await apiClient.get<{ ok: boolean; jobs: FailedJobDto[] }>(
        '/api/admin/ops/failed-jobs?limit=50',
      );
      setFailedJobs(res.jobs);
    } catch (err: any) {
      showToast(err?.message || 'Không thể tải danh sách job lỗi', 'error');
    } finally {
      setJobsLoading(false);
    }
  }, [showToast]);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchMetrics(), fetchFailedJobs()]);
  }, [fetchMetrics, fetchFailedJobs]);

  useEffect(() => {
    refreshAll();
    const timer = setInterval(refreshAll, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshAll]);

  const handleRetry = async (job: FailedJobDto) => {
    if (retryingId) return;
    setRetryingId(job.jobId);
    try {
      await apiClient.post(`/api/admin/ops/failed-jobs/${job.jobId}/retry`);
      showToast(`Đã đưa job #${job.jobId.slice(0, 8)} vào hàng đợi lại`, 'success');
      await fetchFailedJobs();
      await fetchMetrics();
    } catch (err: any) {
      showToast(err?.message || `Không thể retry job ${job.jobId}`, 'error');
    } finally {
      setRetryingId(null);
    }
  };

  const formatMs = (ms: number | null | undefined): string => {
    if (ms == null) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatPct = (pct: number | null | undefined): string => {
    if (pct == null) return '—';
    return `${pct.toFixed(1)}%`;
  };

  const formatDate = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('vi-VN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      day: '2-digit', month: '2-digit',
    });
  };

  const timeoutPct = metrics?.timeoutRatePct ?? 0;
  const timeoutColor =
    timeoutPct > 20 ? 'text-red-400' : timeoutPct > 5 ? 'text-amber-400' : 'text-emerald-400';
  const timeoutBg =
    timeoutPct > 20 ? 'bg-red-500/10 border-red-500/20' : timeoutPct > 5 ? 'bg-amber-500/10 border-amber-500/20' : 'bg-emerald-500/10 border-emerald-500/20';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Activity className="w-5 h-5 text-amber-400" />
            Giám sát Vận hành
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Sourcing queue · Scraper latency · Dead-letter jobs — cập nhật mỗi 30s
          </p>
        </div>
        <button
          onClick={refreshAll}
          disabled={metricsLoading || jobsLoading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${metricsLoading || jobsLoading ? 'animate-spin' : ''}`} />
          Làm mới
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Timeout rate */}
        <div className={`rounded-xl border p-4 ${timeoutBg}`}>
          <div className="flex items-center gap-2 mb-2">
            <Timer className="w-4 h-4 text-slate-400" />
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">
              Tỷ lệ Timeout
            </span>
          </div>
          <div className={`text-2xl font-bold ${timeoutColor}`}>
            {metricsLoading ? '...' : formatPct(metrics?.timeoutRatePct)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {metrics?.totalAttempts ?? 0} lượt sourcing (24h)
          </div>
        </div>

        {/* Sweeper rescues */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert className="w-4 h-4 text-slate-400" />
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">
              Sweeper giải cứu
            </span>
          </div>
          <div className="text-2xl font-bold text-slate-100">
            {metricsLoading ? '...' : (metrics?.sweeperRescueCount ?? 0)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">đơn quá hạn được cứu (24h)</div>
        </div>

        {/* Avg latency */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-slate-400" />
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">
              Latency trung bình
            </span>
          </div>
          <div className="text-2xl font-bold text-slate-100">
            {metricsLoading ? '...' : formatMs(metrics?.avgSourcingLatencyMs)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">từ đặt hàng → fulfilled</div>
        </div>

        {/* Failed jobs count */}
        <div className={`rounded-xl border p-4 ${(metrics?.failedJobCount ?? 0) > 0 ? 'bg-red-500/10 border-red-500/20' : 'bg-slate-900/50 border-slate-800'}`}>
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className={`w-4 h-4 ${(metrics?.failedJobCount ?? 0) > 0 ? 'text-red-400' : 'text-slate-400'}`} />
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">
              Job thất bại
            </span>
          </div>
          <div className={`text-2xl font-bold ${(metrics?.failedJobCount ?? 0) > 0 ? 'text-red-400' : 'text-slate-100'}`}>
            {metricsLoading ? '...' : (metrics?.failedJobCount ?? 0)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">trong dead-letter queue</div>
        </div>
      </div>

      {/* Per-supplier stats */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-slate-200">Thống kê theo Nhà cung cấp</h2>
        </div>
        <div className="overflow-x-auto">
          {metricsLoading ? (
            <div className="px-4 py-8 text-center text-slate-500 text-sm">Đang tải...</div>
          ) : !metrics?.perSupplier?.length ? (
            <div className="px-4 py-8 text-center text-slate-500 text-sm">
              Chưa có dữ liệu sourcing trong 24h qua
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Nhà cung cấp</th>
                  <th className="text-right px-4 py-2.5 text-slate-400 font-medium">Thành công</th>
                  <th className="text-right px-4 py-2.5 text-slate-400 font-medium">Thất bại</th>
                  <th className="text-right px-4 py-2.5 text-slate-400 font-medium">Timeout</th>
                  <th className="text-right px-4 py-2.5 text-slate-400 font-medium">Latency TB</th>
                </tr>
              </thead>
              <tbody>
                {metrics.perSupplier.map((s, i) => (
                  <tr key={s.supplierSourceId ?? `null-${i}`} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 text-slate-200 font-medium">{s.supplierName}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-emerald-400 font-semibold">{s.successCount}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={s.failCount > 0 ? 'text-red-400 font-semibold' : 'text-slate-400'}>
                        {s.failCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={s.timeoutCount > 0 ? 'text-amber-400 font-semibold' : 'text-slate-400'}>
                        {s.timeoutCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-300">{formatMs(s.avgLatencyMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Failed jobs dead-letter */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            <h2 className="text-sm font-semibold text-slate-200">Dead-letter Queue — sourcing-queue</h2>
          </div>
          <span className="text-[11px] text-slate-500">
            BullMQ giữ tối đa 100 job lỗi (removeOnFail)
          </span>
        </div>
        <div className="overflow-x-auto">
          {jobsLoading ? (
            <div className="px-4 py-8 text-center text-slate-500 text-sm">Đang tải...</div>
          ) : failedJobs.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-500 text-sm">
              Không có job thất bại — hệ thống sạch
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Job ID</th>
                  <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Đơn hàng</th>
                  <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Lỗi</th>
                  <th className="text-right px-4 py-2.5 text-slate-400 font-medium">Lần thử</th>
                  <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Thời điểm</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {failedJobs.map((job) => (
                  <tr key={job.jobId} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-slate-400">
                      #{job.jobId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-300">
                      #{job.orderId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 text-slate-300 max-w-xs truncate" title={job.failedReason}>
                      {job.failedReason}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-300">{job.attemptsMade}</td>
                    <td className="px-4 py-3 text-slate-400">{formatDate(job.failedAt)}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleRetry(job)}
                        disabled={retryingId === job.jobId}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <RotateCcw className={`w-3 h-3 ${retryingId === job.jobId ? 'animate-spin' : ''}`} />
                        {retryingId === job.jobId ? 'Đang retry...' : 'Retry'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
