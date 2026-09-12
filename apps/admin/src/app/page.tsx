'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Package,
  Truck,
  ArrowRight,
  TrendingUp,
  Layers,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type { AdminProductDto, SupplierSourceDto } from '@repo/shared-types';
import { apiClient } from '../lib/api-client';

export default function AdminHomePage() {
  const [products, setProducts] = useState<AdminProductDto[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierSourceDto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadOverview = async () => {
      try {
        const [prodRes, supRes] = await Promise.all([
          apiClient.get<{ ok: boolean; products: AdminProductDto[] }>('/api/admin/products'),
          apiClient.get<{ ok: boolean; suppliers: SupplierSourceDto[] }>('/api/admin/suppliers'),
        ]);
        setProducts(prodRes.products || []);
        setSuppliers(supRes.suppliers || []);
      } catch {
        // Handled silently
      } finally {
        setLoading(false);
      }
    };
    loadOverview();
  }, []);

  const totalActive = products.filter((p) => p.isActive).length;
  const totalExternal = products.filter((p) => p.sourcingMode !== 'IN_HOUSE').length;
  const activeSuppliers = suppliers.filter((s) => s.isActive).length;
  const totalInventory = products.reduce((acc, p) => acc + (p.availableCount || 0), 0);

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Welcome banner */}
      <div className="bg-gradient-to-r from-amber-500/10 via-slate-900 to-slate-900 border border-amber-500/20 rounded-2xl p-6 mb-8">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30 mb-2">
              <Zap className="w-3.5 h-3.5" />
              <span>Epic 5: Admin Operational Console</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-100">Bảng điều khiển Quản trị 9Router</h1>
            <p className="text-xs text-slate-400 mt-1">
              Quản trị danh mục, định giá biên lợi nhuận tự động và điều phối chuỗi cung ứng đa nguồn
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/products"
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-colors shadow-lg shadow-amber-500/20"
            >
              <span>Quản lý sản phẩm</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between text-slate-400 mb-3">
            <span className="text-xs font-medium uppercase tracking-wider">Tổng sản phẩm</span>
            <Package className="w-4 h-4 text-amber-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-slate-100">
            {loading ? '...' : products.length}
          </p>
          <p className="text-[11px] text-emerald-400 mt-1">
            ✓ {totalActive} sản phẩm đang đăng bán
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between text-slate-400 mb-3">
            <span className="text-xs font-medium uppercase tracking-wider">Nguồn ngoài / Hybrid</span>
            <TrendingUp className="w-4 h-4 text-blue-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-slate-100">
            {loading ? '...' : totalExternal}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">
            Tự động gọi scraper khi hết kho
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between text-slate-400 mb-3">
            <span className="text-xs font-medium uppercase tracking-wider">Nhà cung cấp</span>
            <Truck className="w-4 h-4 text-purple-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-slate-100">
            {loading ? '...' : suppliers.length}
          </p>
          <p className="text-[11px] text-emerald-400 mt-1">
            ✓ {activeSuppliers} đối tác đang kết nối
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between text-slate-400 mb-3">
            <span className="text-xs font-medium uppercase tracking-wider">Kho key nội bộ</span>
            <Layers className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-slate-100">
            {loading ? '...' : totalInventory}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">
            Key khả dụng trong kho (Story 5.2)
          </p>
        </div>
      </div>

      {/* Quick Navigation Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-slate-100 font-bold">
              <Package className="w-5 h-5 text-amber-400" />
              <h2>Danh mục Sản phẩm Gần đây</h2>
            </div>
            <Link href="/products" className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1">
              <span>Xem tất cả</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="divide-y divide-slate-800 text-xs">
            {products.slice(0, 4).map((p) => (
              <div key={p.id} className="py-2.5 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-slate-200">{p.title}</p>
                  <p className="text-[11px] text-slate-500 font-mono">{p.category} • {p.sourcingMode}</p>
                </div>
                <div className="text-right font-mono">
                  <p className="font-semibold text-slate-100">
                    {parseFloat(p.price).toLocaleString('vi-VN')} ₫
                  </p>
                  <span className={`text-[10px] ${p.isActive ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {p.isActive ? 'Đang bán' : 'Tạm ngưng'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-slate-100 font-bold">
              <Truck className="w-5 h-5 text-amber-400" />
              <h2>Nhà cung cấp Hoạt động</h2>
            </div>
            <Link href="/suppliers" className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1">
              <span>Cấu hình</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="divide-y divide-slate-800 text-xs">
            {suppliers.slice(0, 4).map((s) => (
              <div key={s.id} className="py-2.5 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-slate-200">{s.name}</p>
                  <p className="text-[11px] text-slate-500 font-mono">
                    Markup: +{s.markupPercentage}% +{parseFloat(s.markupFixedVnd).toLocaleString('vi-VN')}đ
                  </p>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  {s.type}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
