'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Package,
  Plus,
  Search,
  Filter,
  Edit2,
  Trash2,
  ExternalLink,
  Power,
  RefreshCw,
} from 'lucide-react';
import {
  ProductSourcingMode,
  type AdminProductDto,
  type SupplierSourceDto,
} from '@repo/shared-types';
import { apiClient } from '../../lib/api-client';
import { useToast } from '../../components/Toast';
import { ProductFormModal } from '../../components/ProductFormModal';

export default function AdminProductsPage() {
  const { showToast } = useToast();
  const [products, setProducts] = useState<AdminProductDto[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierSourceDto[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [sourcingFilter, setSourcingFilter] = useState('ALL');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<AdminProductDto | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [prodRes, supRes] = await Promise.all([
        apiClient.get<{ ok: boolean; products: AdminProductDto[] }>('/api/admin/products'),
        apiClient.get<{ ok: boolean; suppliers: SupplierSourceDto[] }>('/api/admin/suppliers'),
      ]);
      setProducts(prodRes.products || []);
      setSuppliers(supRes.suppliers || []);
    } catch (err: any) {
      showToast(err?.message || 'Không thể tải danh sách sản phẩm', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return Array.from(set);
  }, [products]);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const matchSearch =
        search === '' ||
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.slug.toLowerCase().includes(search.toLowerCase());

      const matchCat = categoryFilter === 'ALL' || p.category === categoryFilter;
      const matchSourcing = sourcingFilter === 'ALL' || p.sourcingMode === sourcingFilter;

      return matchSearch && matchCat && matchSourcing;
    });
  }, [products, search, categoryFilter, sourcingFilter]);

  const handleToggleActive = async (p: AdminProductDto) => {
    try {
      await apiClient.patch(`/api/admin/products/${p.id}`, {
        isActive: !p.isActive,
      });
      setProducts((prev) =>
        prev.map((item) => (item.id === p.id ? { ...item, isActive: !item.isActive } : item)),
      );
      showToast(
        p.isActive ? `Đã tắt sản phẩm "${p.title}"` : `Đã kích hoạt sản phẩm "${p.title}"`,
      );
    } catch (err: any) {
      showToast(err?.message || 'Không thể đổi trạng thái sản phẩm', 'error');
    }
  };

  const handleDelete = async (p: AdminProductDto) => {
    if (!confirm(`Bạn có chắc muốn vô hiệu hóa/xóa sản phẩm "${p.title}"?`)) return;

    try {
      await apiClient.delete(`/api/admin/products/${p.id}`);
      showToast(`Đã vô hiệu hóa sản phẩm "${p.title}"`);
      fetchData();
    } catch (err: any) {
      showToast(err?.message || 'Không thể xóa sản phẩm', 'error');
    }
  };

  const getSourcingBadge = (mode: ProductSourcingMode) => {
    switch (mode) {
      case ProductSourcingMode.IN_HOUSE:
        return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
      case ProductSourcingMode.EXTERNAL:
        return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case ProductSourcingMode.HYBRID:
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      default:
        return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2.5">
            <Package className="w-6 h-6 text-amber-400" />
            <h1 className="text-2xl font-bold text-slate-100">Quản trị Sản phẩm</h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Quản lý danh mục, cấu hình nguồn cấp (Kho / Ngoài), và quy tắc định giá bán lẻ
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={fetchData}
            title="Làm mới dữ liệu"
            className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-amber-400' : ''}`} />
          </button>
          <button
            onClick={() => {
              setEditingProduct(null);
              setIsModalOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-colors shadow-lg shadow-amber-500/20"
          >
            <Plus className="w-4 h-4" />
            <span>Thêm sản phẩm</span>
          </button>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-6">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm theo tên hoặc slug sản phẩm..."
            className="w-full pl-9 pr-3.5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
          />
        </div>

        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-500 shrink-0" />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-amber-500"
          >
            <option value="ALL">Tất cả danh mục ({categories.length})</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div>
          <select
            value={sourcingFilter}
            onChange={(e) => setSourcingFilter(e.target.value)}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-amber-500"
          >
            <option value="ALL">Tất cả nguồn cung</option>
            <option value={ProductSourcingMode.IN_HOUSE}>IN_HOUSE (Kho nội bộ)</option>
            <option value={ProductSourcingMode.EXTERNAL}>EXTERNAL (Nguồn ngoài)</option>
            <option value={ProductSourcingMode.HYBRID}>HYBRID (Kho ➔ Ngoài)</option>
          </select>
        </div>
      </div>

      {/* Products Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Sản phẩm</th>
                <th className="py-3 px-3">Danh mục</th>
                <th className="py-3 px-3">Nguồn cung</th>
                <th className="py-3 px-3 text-right">Giá bán lẻ</th>
                <th className="py-3 px-3 text-right">Giá vốn</th>
                <th className="py-3 px-3 text-center">Tồn kho</th>
                <th className="py-3 px-3">Nhà cung cấp</th>
                <th className="py-3 px-3 text-center">Trạng thái</th>
                <th className="py-3 px-4 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    Đang tải danh sách sản phẩm...
                  </td>
                </tr>
              ) : filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    Không tìm thấy sản phẩm nào phù hợp.
                  </td>
                </tr>
              ) : (
                filteredProducts.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-4 font-medium text-slate-100">
                      <div>
                        <p className="font-semibold text-sm">{p.title}</p>
                        <p className="text-[11px] font-mono text-slate-500">{p.slug}</p>
                      </div>
                    </td>

                    <td className="py-3.5 px-3">
                      <span className="inline-block px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 font-medium">
                        {p.category}
                      </span>
                    </td>

                    <td className="py-3.5 px-3">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${getSourcingBadge(
                          p.sourcingMode,
                        )}`}
                      >
                        {p.sourcingMode}
                      </span>
                    </td>

                    <td className="py-3.5 px-3 text-right font-mono font-semibold text-slate-100">
                      {parseFloat(p.price).toLocaleString('vi-VN')} ₫
                    </td>

                    <td className="py-3.5 px-3 text-right font-mono text-slate-400">
                      {p.upstreamCost ? `${parseFloat(p.upstreamCost).toLocaleString('vi-VN')} ₫` : '—'}
                    </td>

                    <td className="py-3.5 px-3 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded font-mono font-bold ${
                          p.availableCount > 0 ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-500 bg-slate-800'
                        }`}
                      >
                        {p.availableCount}
                      </span>
                      <span className="text-[10px] text-slate-500 ml-1">/ {p.soldCount} bán</span>
                    </td>

                    <td className="py-3.5 px-3 text-slate-300">
                      {p.supplierSourceName ? (
                        <div className="flex items-center gap-1 text-slate-200">
                          <span className="truncate max-w-[120px]">{p.supplierSourceName}</span>
                          {p.supplierProductUrl && (
                            <a
                              href={p.supplierProductUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate-500 hover:text-amber-400"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>

                    <td className="py-3.5 px-3 text-center">
                      <button
                        onClick={() => handleToggleActive(p)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                          p.isActive
                            ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30'
                            : 'bg-slate-800 text-slate-400 hover:bg-slate-700 border border-slate-700'
                        }`}
                      >
                        <Power className="w-3 h-3" />
                        <span>{p.isActive ? 'Bật' : 'Tắt'}</span>
                      </button>
                    </td>

                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => {
                            setEditingProduct(p);
                            setIsModalOpen(true);
                          }}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-800 transition-colors"
                          title="Sửa sản phẩm"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(p)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors"
                          title="Vô hiệu hóa"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Product Form Modal */}
      <ProductFormModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSaved={fetchData}
        product={editingProduct}
        suppliers={suppliers}
      />
    </main>
  );
}
