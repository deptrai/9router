'use client';

import React, { useState, useEffect } from 'react';
import {
  Truck,
  Plus,
  Edit2,
  Trash2,
  ExternalLink,
  Power,
  RefreshCw,
  Percent,
  Coins,
  Link as LinkIcon,
} from 'lucide-react';
import type { SupplierSourceDto } from '@repo/shared-types';
import { apiClient } from '../../lib/api-client';
import { useToast } from '../../components/Toast';
import { SupplierFormModal } from '../../components/SupplierFormModal';

export default function AdminSuppliersPage() {
  const { showToast } = useToast();
  const [suppliers, setSuppliers] = useState<SupplierSourceDto[]>([]);
  const [loading, setLoading] = useState(true);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<SupplierSourceDto | null>(null);

  const fetchSuppliers = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ ok: boolean; suppliers: SupplierSourceDto[] }>(
        '/api/admin/suppliers',
      );
      setSuppliers(res.suppliers || []);
    } catch (err: any) {
      showToast(err?.message || 'Không thể tải danh sách nhà cung cấp', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSuppliers();
  }, []);

  const handleToggleActive = async (s: SupplierSourceDto) => {
    try {
      await apiClient.patch(`/api/admin/suppliers/${s.id}`, {
        isActive: !s.isActive,
      });
      setSuppliers((prev) =>
        prev.map((item) => (item.id === s.id ? { ...item, isActive: !item.isActive } : item)),
      );
      showToast(
        s.isActive ? `Đã tắt nhà cung cấp "${s.name}"` : `Đã kích hoạt nhà cung cấp "${s.name}"`,
      );
    } catch (err: any) {
      showToast(err?.message || 'Không thể đổi trạng thái nhà cung cấp', 'error');
    }
  };

  const handleDelete = async (s: SupplierSourceDto) => {
    if (!confirm(`Bạn có chắc muốn vô hiệu hóa nhà cung cấp "${s.name}"?`)) return;

    try {
      await apiClient.delete(`/api/admin/suppliers/${s.id}`);
      showToast(`Đã vô hiệu hóa nhà cung cấp "${s.name}"`);
      fetchSuppliers();
    } catch (err: any) {
      showToast(err?.message || 'Không thể xóa nhà cung cấp', 'error');
    }
  };

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2.5">
            <Truck className="w-6 h-6 text-amber-400" />
            <h1 className="text-2xl font-bold text-slate-100">Quản trị Nhà cung cấp</h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Cấu hình đối tác nguồn ngoài, tỷ lệ Markup (% / cố định) và danh sách credential kho tự động
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={fetchSuppliers}
            title="Làm mới dữ liệu"
            className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-amber-400' : ''}`} />
          </button>
          <button
            onClick={() => {
              setEditingSupplier(null);
              setIsModalOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-colors shadow-lg shadow-amber-500/20"
          >
            <Plus className="w-4 h-4" />
            <span>Thêm nhà cung cấp</span>
          </button>
        </div>
      </div>

      {/* Suppliers Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl mt-6">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Nhà cung cấp</th>
                <th className="py-3 px-3">Loại tích hợp</th>
                <th className="py-3 px-3">Markup (%)</th>
                <th className="py-3 px-3 text-right">Phụ phí cố định</th>
                <th className="py-3 px-3 text-center">SP liên kết</th>
                <th className="py-3 px-3 text-center">Trạng thái</th>
                <th className="py-3 px-4 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    Đang tải danh sách nhà cung cấp...
                  </td>
                </tr>
              ) : suppliers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    Chưa có nhà cung cấp nào được cấu hình.
                  </td>
                </tr>
              ) : (
                suppliers.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-4 font-medium text-slate-100">
                      <div>
                        <p className="font-semibold text-sm">{s.name}</p>
                        {s.targetUrl ? (
                          <a
                            href={s.targetUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] text-slate-500 hover:text-amber-400 flex items-center gap-1 mt-0.5"
                          >
                            <span className="truncate max-w-[200px]">{s.targetUrl}</span>
                            <ExternalLink className="w-3 h-3 shrink-0" />
                          </a>
                        ) : (
                          <span className="text-[11px] text-slate-600">Không có website</span>
                        )}
                      </div>
                    </td>

                    <td className="py-3.5 px-3">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                          s.type === 'CONFIG_POOL'
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                            : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                        }`}
                      >
                        {s.type}
                      </span>
                    </td>

                    <td className="py-3.5 px-3 font-mono font-medium text-slate-200">
                      <div className="flex items-center gap-1">
                        <Percent className="w-3.5 h-3.5 text-slate-500" />
                        <span>+{s.markupPercentage}%</span>
                      </div>
                    </td>

                    <td className="py-3.5 px-3 text-right font-mono font-medium text-slate-200">
                      <div className="flex items-center justify-end gap-1">
                        <Coins className="w-3.5 h-3.5 text-slate-500" />
                        <span>+{parseFloat(s.markupFixedVnd).toLocaleString('vi-VN')} ₫</span>
                      </div>
                    </td>

                    <td className="py-3.5 px-3 text-center">
                      <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 font-mono font-semibold text-[11px]">
                        <LinkIcon className="w-3 h-3 text-slate-500" />
                        <span>{s.linkedProductsCount ?? 0}</span>
                      </div>
                    </td>

                    <td className="py-3.5 px-3 text-center">
                      <button
                        onClick={() => handleToggleActive(s)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                          s.isActive
                            ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30'
                            : 'bg-slate-800 text-slate-400 hover:bg-slate-700 border border-slate-700'
                        }`}
                      >
                        <Power className="w-3 h-3" />
                        <span>{s.isActive ? 'Bật' : 'Tắt'}</span>
                      </button>
                    </td>

                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => {
                            setEditingSupplier(s);
                            setIsModalOpen(true);
                          }}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-800 transition-colors"
                          title="Sửa nhà cung cấp"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(s)}
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

      {/* Supplier Form Modal */}
      <SupplierFormModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSaved={fetchSuppliers}
        supplier={editingSupplier}
      />
    </main>
  );
}
