'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import {
  Package,
  Layers,
  Key,
  Eye,
  EyeOff,
  Trash2,
  AlertTriangle,
  CheckCircle,
  Clock,
  XCircle,
  RefreshCw,
  Search,
  Plus,
  Copy,
  Check,
} from 'lucide-react';
import type { AdminProductDto, AdminInventoryItemDto, ProductStockSummaryDto } from '@repo/shared-types';
import { apiClient } from '../../lib/api-client';
import { formatDate } from '../../lib/formatters';
import { BatchImportModal } from '../../components/BatchImportModal';

export default function AdminInventoryPage() {
  // State
  const [products, setProducts] = useState<AdminProductDto[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<AdminProductDto | null>(null);
  const [inventoryItems, setInventoryItems] = useState<AdminInventoryItemDto[]>([]);
  const [productSummary, setProductSummary] = useState<{
    available: number;
    reserved: number;
    sold: number;
    defective: number;
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [showImportModal, setShowImportModal] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [revealedCredential, setRevealedCredential] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const pageSize = 50;

  // Fetch products on mount
  useEffect(() => {
    const fetchProducts = async () => {
      try {
        const res = await apiClient.get<{ ok: boolean; products: AdminProductDto[] }>('/api/admin/products');
        setProducts(res.products || []);
        if (res.products?.length > 0 && !selectedProduct) {
          setSelectedProduct(res.products[0]);
        }
      } catch (err) {
        showToast('Không thể tải danh sách sản phẩm', 'error');
      } finally {
        setLoading(false);
      }
    };
    fetchProducts();
  }, []);

  // Fetch inventory when product changes
  useEffect(() => {
    if (selectedProduct) {
      fetchInventory();
      fetchProductSummary();
    }
  }, [selectedProduct, statusFilter, page]);

  const fetchInventory = async () => {
    if (!selectedProduct) return;
    setItemsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('offset', String(page * pageSize));
      if (statusFilter !== 'ALL') {
        params.set('status', statusFilter);
      }
      const res = await apiClient.get<{ ok: boolean; items: AdminInventoryItemDto[]; total: number }>(
        `/api/admin/inventory/products/${selectedProduct.id}?${params.toString()}`
      );
      setInventoryItems(res.items || []);
      setTotal(res.total || 0);
    } catch (err) {
      showToast('Không thể tải danh sách credential', 'error');
    } finally {
      setItemsLoading(false);
    }
  };

  const fetchProductSummary = async () => {
    if (!selectedProduct) return;
    try {
      const res = await apiClient.get<{ ok: boolean; summary: any }>(
        `/api/admin/inventory/products/${selectedProduct.id}/summary`
      );
      setProductSummary(res.summary);
    } catch (err) {
      // Silent fail for summary
    }
  };

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleImport = async (credentials: string[]) => {
    if (!selectedProduct) return;
    await apiClient.post(`/api/admin/inventory/products/${selectedProduct.id}/batch`, {
      credentials,
    });
    showToast(`Đã nhập thành công ${credentials.length} key vào kho`, 'success');
    fetchInventory();
    fetchProductSummary();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Bạn có chắc muốn xóa credential này?')) return;
    try {
      await apiClient.delete(`/api/admin/inventory/items/${id}`);
      showToast('Đã xóa credential', 'success');
      fetchInventory();
      fetchProductSummary();
    } catch (err: any) {
      showToast(err?.message || 'Không thể xóa credential', 'error');
    }
  };

  const handleMarkDefective = async (id: string) => {
    try {
      await apiClient.patch(`/api/admin/inventory/items/${id}/status`, { status: 'DEFECTIVE' });
      showToast('Đã đánh dấu credential hỏng', 'success');
      fetchInventory();
      fetchProductSummary();
    } catch (err: any) {
      showToast(err?.message || 'Không thể đánh dấu hỏng', 'error');
    }
  };

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleReveal = async (id: string) => {
    if (revealedId === id) {
      setRevealedId(null);
      setRevealedCredential(null);
      return;
    }
    try {
      const res = await apiClient.get<{ ok: boolean; credential: string }>(
        `/api/admin/inventory/items/${id}/decrypt`
      );
      setRevealedId(id);
      setRevealedCredential(res.credential);
    } catch (err) {
      showToast('Không thể xem credential', 'error');
    }
  };

  // Filter products by search
  const filteredProducts = useMemo(() => {
    if (!searchQuery) return products;
    const q = searchQuery.toLowerCase();
    return products.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        p.category?.toLowerCase().includes(q)
    );
  }, [products, searchQuery]);

  const totalPages = Math.ceil(total / pageSize);

  const statusBadge = (status: string) => {
    const config: Record<string, { bg: string; text: string; label: string }> = {
      AVAILABLE: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', label: 'Khả dụng' },
      RESERVED: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Đang giữ' },
      SOLD: { bg: 'bg-slate-500/10', text: 'text-slate-400', label: 'Đã bán' },
      DEFECTIVE: { bg: 'bg-rose-500/10', text: 'text-rose-400', label: 'Hỏng' },
    };
    const c = config[status] || config.AVAILABLE;
    return (
      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${c.bg} ${c.text}`}>
        {c.label}
      </span>
    );
  };



  if (loading) {
    return (
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="w-6 h-6 text-amber-400 animate-spin" />
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-sm font-medium shadow-lg ${
            toast.type === 'success'
              ? 'bg-emerald-500/90 text-white'
              : 'bg-rose-500/90 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Layers className="w-6 h-6 text-amber-400" />
            Quản lý Kho Hàng Nội bộ
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Nhập lô credential, theo dõi tồn kho và trạng thái bán hàng
          </p>
        </div>
        <button
          onClick={() => setShowImportModal(true)}
          disabled={!selectedProduct || selectedProduct.sourcingMode === 'EXTERNAL' || !selectedProduct.isActive}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4" />
          <span>Nhập lô Credential</span>
        </button>
      </div>

      {/* Product Selector */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              placeholder="Tìm sản phẩm..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500/50"
            />
          </div>
          <select
            value={selectedProduct?.id || ''}
            onChange={(e) => {
              const p = products.find((x) => x.id === e.target.value);
              setSelectedProduct(p || null);
              setPage(0);
            }}
            className="px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-amber-500/50"
          >
            {filteredProducts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.availableCount || 0} keys)
              </option>
            ))}
          </select>
        </div>

        {/* Selected product info */}
        {selectedProduct && (
          <div className="mt-4 flex items-center gap-4 text-xs">
            <span className="text-slate-400">Sản phẩm:</span>
            <span className="font-semibold text-slate-200">{selectedProduct.title}</span>
            <span className={`px-2 py-0.5 rounded-full ${
              selectedProduct.sourcingMode === 'IN_HOUSE'
                ? 'bg-blue-500/10 text-blue-400'
                : selectedProduct.sourcingMode === 'HYBRID'
                ? 'bg-purple-500/10 text-purple-400'
                : 'bg-amber-500/10 text-amber-400'
            }`}>
              {selectedProduct.sourcingMode}
            </span>
            {!selectedProduct.isActive && (
              <span className="px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400">
                Tạm ngưng
              </span>
            )}
          </div>
        )}
      </div>

      {/* KPI Cards */}
      {selectedProduct && productSummary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-emerald-400 mb-2">
              <CheckCircle className="w-4 h-4" />
              <span className="text-xs font-semibold">Khả dụng</span>
            </div>
            <p className="text-2xl font-bold font-mono text-slate-100">{productSummary.available}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-blue-400 mb-2">
              <Clock className="w-4 h-4" />
              <span className="text-xs font-semibold">Đang giữ</span>
            </div>
            <p className="text-2xl font-bold font-mono text-slate-100">{productSummary.reserved}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-slate-400 mb-2">
              <Package className="w-4 h-4" />
              <span className="text-xs font-semibold">Đã bán</span>
            </div>
            <p className="text-2xl font-bold font-mono text-slate-100">{productSummary.sold}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-rose-400 mb-2">
              <XCircle className="w-4 h-4" />
              <span className="text-xs font-semibold">Hỏng</span>
            </div>
            <p className="text-2xl font-bold font-mono text-slate-100">{productSummary.defective}</p>
          </div>
        </div>
      )}

      {/* Status Filter */}
      <div className="flex items-center gap-2 mb-4">
        {['ALL', 'AVAILABLE', 'RESERVED', 'SOLD', 'DEFECTIVE'].map((s) => (
          <button
            key={s}
            onClick={() => {
              setStatusFilter(s);
              setPage(0);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              statusFilter === s
                ? 'bg-amber-500 text-slate-950'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            {s === 'ALL' ? 'Tất cả' : s === 'AVAILABLE' ? 'Khả dụng' : s === 'RESERVED' ? 'Đang giữ' : s === 'SOLD' ? 'Đã bán' : 'Hỏng'}
          </button>
        ))}
      </div>

      {/* Inventory Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-950/50">
            <tr className="text-left text-xs text-slate-400">
              <th className="px-4 py-3 font-semibold">Mã ID</th>
              <th className="px-4 py-3 font-semibold">Trạng thái</th>
              <th className="px-4 py-3 font-semibold">Credential</th>
              <th className="px-4 py-3 font-semibold">Ngày nhập</th>
              <th className="px-4 py-3 font-semibold">Đơn hàng</th>
              <th className="px-4 py-3 font-semibold text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {itemsLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto" />
                </td>
              </tr>
            ) : inventoryItems.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  Chưa có credential nào trong kho
                </td>
              </tr>
            ) : (
              inventoryItems.map((item) => (
                <tr key={item.id} className="text-xs hover:bg-slate-800/30">
                  <td className="px-4 py-3 font-mono text-slate-400">{item.id.slice(0, 8)}...</td>
                  <td className="px-4 py-3">{statusBadge(item.status)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {revealedId === item.id ? (
                        <span className="font-mono text-amber-400">{revealedCredential}</span>
                      ) : (
                        <span className="font-mono text-slate-300">{item.maskedCredential}</span>
                      )}
                      <button
                        onClick={() => handleCopy(revealedId === item.id ? revealedCredential! : item.maskedCredential, item.id)}
                        className="p-1 rounded text-slate-500 hover:text-slate-300"
                        title="Copy"
                      >
                        {copiedId === item.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        onClick={() => handleReveal(item.id)}
                        className="p-1 rounded text-slate-500 hover:text-slate-300"
                        title={revealedId === item.id ? 'Ẩn' : 'Xem'}
                      >
                        {revealedId === item.id ? (
                          <EyeOff className="w-3.5 h-3.5" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{formatDate(item.addedAt)}</td>
                  <td className="px-4 py-3 font-mono text-slate-400">
                    {item.orderId ? item.orderId.slice(0, 8) + '...' : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {item.status === 'AVAILABLE' && (
                        <>
                          <button
                            onClick={() => handleMarkDefective(item.id)}
                            className="p-1.5 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800"
                            title="Báo hỏng"
                          >
                            <AlertTriangle className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="p-1.5 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800"
                            title="Xóa"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                      {item.status === 'DEFECTIVE' && (
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="p-1.5 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800"
                          title="Xóa"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                      {(item.status === 'RESERVED' || item.status === 'SOLD') && (
                        <span className="text-slate-600 text-[10px]">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800">
            <p className="text-xs text-slate-500">
              Hiển thị {inventoryItems.length} / {total} credential
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1 rounded-lg bg-slate-800 text-xs text-slate-300 disabled:opacity-50"
              >
                Trước
              </button>
              <span className="text-xs text-slate-500">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-3 py-1 rounded-lg bg-slate-800 text-xs text-slate-300 disabled:opacity-50"
              >
                Sau
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Import Modal */}
      <BatchImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={() => {
          fetchInventory();
          fetchProductSummary();
        }}
        product={selectedProduct}
        onSubmit={handleImport}
      />
    </main>
  );
}
