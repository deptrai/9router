'use client';

import React, { useState, useEffect } from 'react';
import { X, Check, Calculator, AlertTriangle, Layers } from 'lucide-react';
import {
  ProductSourcingMode,
  type AdminProductDto,
  type SupplierSourceDto,
  type CreateProductDto,
} from '@repo/shared-types';
import { apiClient } from '../lib/api-client';
import { useToast } from './Toast';

/** Parse a decimal string to scale-2 BigInt units (1 VND = 100 units) */
function parseToScale2(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed || isNaN(Number(trimmed))) return 0n;
  const [intPart, decPart = ''] = trimmed.split('.');
  const dec = (decPart + '00').slice(0, 2);
  return BigInt(intPart) * 100n + BigInt(dec);
}

/** Format scale-2 BigInt units back to decimal string */
function formatScale2(units: bigint): string {
  const vnd = units / 100n;
  const cents = units % 100n;
  return `${vnd}.${cents.toString().padStart(2, '0')}`;
}


interface ProductFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  product?: AdminProductDto | null;
  suppliers: SupplierSourceDto[];
}

export function ProductFormModal({
  isOpen,
  onClose,
  onSaved,
  product,
  suppliers,
}: ProductFormModalProps) {
  const { showToast } = useToast();
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [category, setCategory] = useState('Subscriptions');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [sourcingMode, setSourcingMode] = useState<ProductSourcingMode>(ProductSourcingMode.IN_HOUSE);
  const [supplierSourceId, setSupplierSourceId] = useState<string>('');
  const [supplierProductUrl, setSupplierProductUrl] = useState('');
  const [upstreamCost, setUpstreamCost] = useState('');
  const [maxUpstreamCost, setMaxUpstreamCost] = useState('');
  const [autoPricing, setAutoPricing] = useState(true);
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (product) {
      setTitle(product.title);
      setSlug(product.slug);
      setCategory(product.category || 'Subscriptions');
      setPrice(product.price);
      setDescription(product.description || '');
      setSourcingMode(product.sourcingMode);
      setSupplierSourceId(product.supplierSourceId || '');
      setSupplierProductUrl(product.supplierProductUrl || '');
      setUpstreamCost(product.upstreamCost || '');
      setMaxUpstreamCost(product.maxUpstreamCost || '');
      setAutoPricing(product.autoPricing);
      setIsActive(product.isActive);
    } else {
      setTitle('');
      setSlug('');
      setCategory('Subscriptions');
      setPrice('50000.00');
      setDescription('');
      setSourcingMode(ProductSourcingMode.IN_HOUSE);
      setSupplierSourceId(suppliers[0]?.id || '');
      setSupplierProductUrl('');
      setUpstreamCost('');
      setMaxUpstreamCost('');
      setAutoPricing(true);
      setIsActive(true);
    }
  }, [product, suppliers, isOpen]);

  // Real-time calculated price preview — mirrors computeRetailPrice from pricing.engine.ts
  // using BigInt scale-2 integer arithmetic to avoid floating-point rounding discrepancies
  const selectedSupplier = suppliers.find((s) => s.id === supplierSourceId);
  let previewPrice: string | null = null;
  if (autoPricing && upstreamCost && selectedSupplier) {
    try {
      const costUnits = parseToScale2(upstreamCost);
      const pctBp = parseToScale2(selectedSupplier.markupPercentage || '0');
      const fixedUnits = parseToScale2(selectedSupplier.markupFixedVnd || '0');
      const rawUnits = (costUnits * (10_000n + pctBp) + fixedUnits * 10_000n) / 10_000n;
      const rounded = ((rawUnits + 50_000n) / 100_000n) * 100_000n;
      const finalUnits = rounded < 100_000n ? 100_000n : rounded;
      previewPrice = formatScale2(finalUnits);
    } catch {
      previewPrice = null;
    }
  }

  const isCostBreached =
    upstreamCost &&
    maxUpstreamCost &&
    parseFloat(upstreamCost) > parseFloat(maxUpstreamCost);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      showToast('Vui lòng nhập tên sản phẩm', 'error');
      return;
    }

    const finalPrice = autoPricing && previewPrice ? previewPrice : price;
    if (!finalPrice || isNaN(parseFloat(finalPrice))) {
      showToast('Vui lòng nhập giá bán hoặc giá vốn hợp lệ để tính giá tự động', 'error');
      return;
    }

    const payload: CreateProductDto = {
      title: title.trim(),
      slug: slug.trim() ? slug.trim() : undefined,
      category: category.trim(),
      price: finalPrice,
      description: description.trim() || null,
      sourcingMode,
      supplierSourceId:
        sourcingMode === ProductSourcingMode.EXTERNAL || sourcingMode === ProductSourcingMode.HYBRID
          ? supplierSourceId || null
          : null,
      supplierProductUrl: supplierProductUrl.trim() || null,
      upstreamCost: upstreamCost.trim() || null,
      maxUpstreamCost: maxUpstreamCost.trim() || null,
      autoPricing,
      isActive,
    };

    setSubmitting(true);
    try {
      if (product) {
        await apiClient.patch(`/api/admin/products/${product.id}`, payload);
        showToast(`Đã cập nhật sản phẩm "${title}"`);
      } else {
        await apiClient.post('/api/admin/products', payload);
        showToast(`Đã tạo sản phẩm "${title}"`);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      showToast(err?.message || 'Có lỗi xảy ra khi lưu sản phẩm', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl my-8">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
          <div className="flex items-center gap-2 text-slate-100">
            <Layers className="w-5 h-5 text-amber-400" />
            <h2 className="text-base font-bold">
              {product ? 'Chỉnh sửa sản phẩm' : 'Thêm sản phẩm mới'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
              Tên sản phẩm *
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="VD: Netflix Premium 1 Tháng"
              className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Slug (Tùy chọn)
              </label>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="Tự động sinh nếu để trống"
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder:text-slate-600 font-mono focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Phân loại
              </label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="VD: Subscriptions, AI Tools..."
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Chế độ nguồn cung
              </label>
              <select
                value={sourcingMode}
                onChange={(e) => setSourcingMode(e.target.value as ProductSourcingMode)}
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:border-amber-500"
              >
                <option value={ProductSourcingMode.IN_HOUSE}>IN_HOUSE (Kho nội bộ)</option>
                <option value={ProductSourcingMode.EXTERNAL}>EXTERNAL (Nguồn ngoài)</option>
                <option value={ProductSourcingMode.HYBRID}>HYBRID (Kho ➔ Ngoài)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Giá bán lẻ (VND) *
              </label>
              <input
                type="text"
                required
                value={autoPricing && previewPrice ? previewPrice : price}
                disabled={autoPricing && Boolean(previewPrice)}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="VD: 75000.00"
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 font-mono disabled:opacity-60"
              />
            </div>
          </div>

          {(sourcingMode === ProductSourcingMode.EXTERNAL || sourcingMode === ProductSourcingMode.HYBRID) && (
            <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl space-y-3">
              <div className="flex items-center gap-1.5 text-xs font-bold text-amber-400">
                <Calculator className="w-3.5 h-3.5" />
                <span>Cấu hình nhà cung cấp ngoài</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-400 mb-1">
                    Nhà cung cấp liên kết *
                  </label>
                  <select
                    value={supplierSourceId}
                    onChange={(e) => setSupplierSourceId(e.target.value)}
                    className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-100 focus:outline-none focus:border-amber-500"
                  >
                    <option value="">-- Chọn nhà cung cấp --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.type}) - Markup: +{s.markupPercentage}% +{s.markupFixedVnd}đ
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-400 mb-1">
                    Giá trần tối đa (Max Upstream Cost)
                  </label>
                  <input
                    type="text"
                    value={maxUpstreamCost}
                    onChange={(e) => setMaxUpstreamCost(e.target.value)}
                    placeholder="VD: 60000.00"
                    className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-100 font-mono focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-400 mb-1">
                    Giá vốn hiện tại (Upstream Cost)
                  </label>
                  <input
                    type="text"
                    value={upstreamCost}
                    onChange={(e) => setUpstreamCost(e.target.value)}
                    placeholder="VD: 50000.00"
                    className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-100 font-mono focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="flex items-center gap-2 pt-5">
                  <input
                    type="checkbox"
                    id="autoPricing"
                    checked={autoPricing}
                    onChange={(e) => setAutoPricing(e.target.checked)}
                    className="w-4 h-4 rounded text-amber-500 bg-slate-900 border-slate-700 focus:ring-amber-500"
                  />
                  <label htmlFor="autoPricing" className="text-xs text-slate-300 select-none">
                    Tự động tính giá lẻ theo Markup
                  </label>
                </div>
              </div>

              {previewPrice && (
                <p className="text-xs text-emerald-400 font-mono">
                  ✓ Giá bán lẻ dự kiến: {parseFloat(previewPrice).toLocaleString('vi-VN')} ₫ (Làm tròn 1.000đ)
                </p>
              )}

              {isCostBreached && (
                <div className="flex items-center gap-1.5 text-xs text-rose-400 bg-rose-500/10 p-2 rounded-lg border border-rose-500/20">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>Cảnh báo: Giá vốn ({upstreamCost}đ) vượt quá giá trần ({maxUpstreamCost}đ)!</span>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
              Mô tả sản phẩm
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Thông tin gói cước, thời hạn bảo hành..."
              className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 resize-none"
            />
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-800">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded text-amber-500 bg-slate-950 border-slate-700 focus:ring-amber-500"
              />
              <span className="text-xs font-semibold text-slate-200">Kích hoạt sản phẩm (Đăng bán)</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition-colors"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-xs font-semibold text-slate-950 transition-colors disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
                <span>{submitting ? 'Đang lưu...' : 'Lưu sản phẩm'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
