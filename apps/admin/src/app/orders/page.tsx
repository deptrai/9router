'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  ClipboardList,
  Search,
  RefreshCw,
  Eye,
  RotateCcw,
  CheckCircle,
  Clock,
  AlertTriangle,
  XCircle,
  Truck,
  User,
  Package,
} from 'lucide-react';
import type { AdminOrderListItemDto, OrderStatus } from '@repo/shared-types';
import { apiClient } from '../../lib/api-client';
import { formatVnd, formatDate } from '../../lib/formatters';
import { useToast } from '../../components/Toast';
import { OrderDetailModal } from '../../components/OrderDetailModal';

interface KpiCounts {
  total: number;
  sourcing: number;
  fulfilled: number;
  refunded: number;
}

export default function AdminOrdersPage() {
  const { showToast } = useToast();
  const [orders, setOrders] = useState<AdminOrderListItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  // Filters & Pagination
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // KPI counts — fetched separately so they reflect system-wide totals, not current page
  const [kpi, setKpi] = useState<KpiCounts>({ total: 0, sourcing: 0, fulfilled: 0, refunded: 0 });

  // Selected order for modal
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('offset', String(page * pageSize));
      if (statusFilter !== 'ALL') {
        params.set('status', statusFilter);
      }
      if (search.trim()) {
        params.set('search', search.trim());
      }

      const res = await apiClient.get<{
        ok: boolean;
        orders: AdminOrderListItemDto[];
        total: number;
      }>(`/api/admin/orders?${params.toString()}`);

      setOrders(res.orders || []);
      setTotal(res.total || 0);
    } catch (err: any) {
      showToast(err?.message || 'Không thể tải danh sách đơn hàng', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Fetch system-wide KPI counts (independent of current filters/pagination)
  const fetchKpi = async () => {
    try {
      const params = new URLSearchParams();
      params.set('limit', '10000'); // fetch all to compute KPI counts
      params.set('offset', '0');
      const res = await apiClient.get<{
        ok: boolean;
        orders: AdminOrderListItemDto[];
        total: number;
      }>(`/api/admin/orders?${params.toString()}`);

      const all = res.orders || [];
      setKpi({
        total: res.total || 0,
        sourcing: all.filter((o) => o.status === 'SOURCING').length,
        fulfilled: all.filter((o) => o.status === 'FULFILLED').length,
        refunded: all.filter((o) => o.status === 'REFUNDED').length,
      });
    } catch (err) {
      // KPI failure is non-fatal — keep showing page-level data
      console.warn('Failed to fetch KPI counts', err);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [page, statusFilter]);

  // Load KPI once on mount + refresh when needed
  useEffect(() => {
    fetchKpi();
  }, []);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(0);
      fetchOrders();
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2.5">
            <ClipboardList className="w-6 h-6 text-amber-400" />
            <h1 className="text-2xl font-bold text-slate-100">Giám sát Đơn hàng & Đối soát</h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Theo dõi trạng thái giao dịch, chuỗi cung ứng Scraper/Kho và xử lý hoàn tiền thủ công
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={fetchOrders}
            title="Làm mới dữ liệu"
            className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-amber-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Tổng đơn hàng</span>
            <Package className="w-4 h-4 text-amber-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-slate-100">{kpi.total}</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-blue-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Chờ mua ngoài</span>
            <Clock className="w-4 h-4" />
          </div>
          <p className="text-2xl font-bold font-mono text-blue-400">{kpi.sourcing}</p>
          <p className="text-[11px] text-slate-500 mt-1">Hàng đợi scraper đang xử lý</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-emerald-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Hoàn tất</span>
            <CheckCircle className="w-4 h-4" />
          </div>
          <p className="text-2xl font-bold font-mono text-emerald-400">{kpi.fulfilled}</p>
          <p className="text-[11px] text-slate-500 mt-1">Đã giao credential cho khách</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Đã hoàn tiền</span>
            <RotateCcw className="w-4 h-4 text-slate-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-slate-300">{kpi.refunded}</p>
          <p className="text-[11px] text-slate-500 mt-1">Đã hoàn 100% ví</p>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm theo Telegram ID, Username, Mã đơn..."
            className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
          />
        </div>

        {/* Status Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {[
            { key: 'ALL', label: 'Tất cả' },
            { key: 'SOURCING', label: 'Chờ mua ngoài' },
            { key: 'PAID', label: 'Đã thanh toán' },
            { key: 'FULFILLED', label: 'Hoàn tất' },
            { key: 'REFUNDED', label: 'Đã hoàn tiền' },
            { key: 'FAILED', label: 'Thất bại' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => {
                setStatusFilter(tab.key);
                setPage(0);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                statusFilter === tab.key
                  ? 'bg-amber-500 text-slate-950 shadow-sm'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Orders Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl mt-4">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Mã đơn</th>
                <th className="py-3 px-3">Khách hàng</th>
                <th className="py-3 px-3">Sản phẩm</th>
                <th className="py-3 px-3 text-right">Số tiền</th>
                <th className="py-3 px-3 text-center">Nguồn xử lý</th>
                <th className="py-3 px-3 text-center">Trạng thái</th>
                <th className="py-3 px-3">Thời gian</th>
                <th className="py-3 px-4 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-500">
                    Đang tải danh sách đơn hàng...
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-500">
                    Không tìm thấy đơn hàng nào phù hợp.
                  </td>
                </tr>
              ) : (
                orders.map((o) => (
                  <tr
                    key={o.id}
                    onClick={() => setSelectedOrderId(o.id)}
                    className="hover:bg-slate-800/40 transition-colors cursor-pointer"
                  >
                    <td className="py-3.5 px-4 font-mono font-bold text-slate-200">
                      #{o.id.slice(0, 8)}
                    </td>

                    <td className="py-3.5 px-3">
                      <div>
                        <p className="font-semibold text-slate-200">
                          {o.username ? `@${o.username}` : 'Khách vãng lai'}
                        </p>
                        <p className="text-[11px] font-mono text-slate-500">ID: {o.telegramId}</p>
                      </div>
                    </td>

                    <td className="py-3.5 px-3 font-medium text-slate-200">
                      <p className="max-w-[180px] truncate">{o.productTitle}</p>
                    </td>

                    <td className="py-3.5 px-3 text-right font-mono font-bold text-slate-100">
                      {formatVnd(o.price)}
                    </td>

                    <td className="py-3.5 px-3 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold border ${
                          o.sourcingMode === 'IN_HOUSE'
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                            : 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                        }`}
                      >
                        {o.supplierName ? o.supplierName : 'Kho nội bộ'}
                      </span>
                    </td>

                    <td className="py-3.5 px-3 text-center">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                          o.status === 'FULFILLED'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : o.status === 'SOURCING'
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse'
                            : o.status === 'REFUNDED'
                            ? 'bg-slate-800 text-slate-400 border-slate-700'
                            : o.status === 'PAID'
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                        }`}
                      >
                        {o.status}
                      </span>
                    </td>

                    <td className="py-3.5 px-3 text-slate-400 text-[11px]">
                      {formatDate(o.createdAt)}
                    </td>

                    <td className="py-3.5 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setSelectedOrderId(o.id)}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                      >
                        Chi tiết
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 px-1">
          <p className="text-xs text-slate-500">
            Hiển thị {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} / {total} đơn hàng
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Trước
            </button>
            <span className="text-xs text-slate-400 font-mono">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Sau
            </button>
          </div>
        </div>
      )}

      {/* Order Detail Modal */}
      <OrderDetailModal
        isOpen={Boolean(selectedOrderId)}
        orderId={selectedOrderId}
        onClose={() => setSelectedOrderId(null)}
        onOrderRefunded={() => {
          fetchOrders();
          fetchKpi();
        }}
        showToast={showToast}
      />
    </main>
  );
}
