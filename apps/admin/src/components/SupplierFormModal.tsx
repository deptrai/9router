'use client';

import React, { useState, useEffect } from 'react';
import { X, Check, Code, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
import type {
  SupplierSourceDto,
  CreateSupplierSourceDto,
} from '@repo/shared-types';
import { apiClient } from '../lib/api-client';
import { useToast } from './Toast';

interface SupplierFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  supplier?: SupplierSourceDto | null;
}

const CONFIG_POOL_PRESET = JSON.stringify(
  {
    priceMap: {
      'netflix-premium-1-thang': '50000.00',
      'spotify-premium-1-thang': '40000.00',
    },
    credentialPool: ['KEY-DEMO-A1', 'KEY-DEMO-B2', 'KEY-DEMO-C3'],
  },
  null,
  2,
);

const WEB_SCRAPER_PRESET = JSON.stringify(
  {
    priceMap: {
      'chatgpt-plus-1-thang': '200000.00',
    },
    scrapingRules: {
      loginSelector: '#username',
      buyButtonSelector: '.checkout-btn',
    },
  },
  null,
  2,
);

export function SupplierFormModal({
  isOpen,
  onClose,
  onSaved,
  supplier,
}: SupplierFormModalProps) {
  const { showToast } = useToast();
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [type, setType] = useState('CONFIG_POOL');
  const [targetUrl, setTargetUrl] = useState('');
  const [markupPercentage, setMarkupPercentage] = useState('10.00');
  const [markupFixedVnd, setMarkupFixedVnd] = useState('5000.00');
  const [isActive, setIsActive] = useState(true);

  // Safe JSON state
  const [rawJson, setRawJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    if (supplier) {
      setName(supplier.name);
      setType(supplier.type);
      setTargetUrl(supplier.targetUrl || '');
      setMarkupPercentage(supplier.markupPercentage || '0.00');
      setMarkupFixedVnd(supplier.markupFixedVnd || '0.00');
      setIsActive(supplier.isActive);
      setRawJson(
        supplier.configCredentials
          ? JSON.stringify(supplier.configCredentials, null, 2)
          : '',
      );
      setJsonError(null);
    } else {
      setName('');
      setType('CONFIG_POOL');
      setTargetUrl('');
      setMarkupPercentage('10.00');
      setMarkupFixedVnd('5000.00');
      setIsActive(true);
      setRawJson(CONFIG_POOL_PRESET);
      setJsonError(null);
    }
  }, [supplier, isOpen]);

  const validateJson = (text: string): boolean => {
    if (!text.trim()) {
      setJsonError(null);
      return true;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonError('JSON phải là một đối tượng (object), không được là mảng hay giá trị nguyên thủy');
        return false;
      }
      setJsonError(null);
      return true;
    } catch (err: any) {
      setJsonError(err.message || 'Cú pháp JSON không hợp lệ');
      return false;
    }
  };

  const handleJsonChange = (text: string) => {
    setRawJson(text);
    validateJson(text);
  };

  const handleFormatJson = () => {
    try {
      if (!rawJson.trim()) return;
      const parsed = JSON.parse(rawJson);
      setRawJson(JSON.stringify(parsed, null, 2));
      setJsonError(null);
      showToast('Đã format JSON');
    } catch (err: any) {
      setJsonError(err.message);
    }
  };

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showToast('Vui lòng nhập tên nhà cung cấp', 'error');
      return;
    }

    if (!validateJson(rawJson)) {
      showToast('Vui lòng sửa lỗi cú pháp JSON trước khi lưu', 'error');
      return;
    }

    let parsedConfig: Record<string, any> | null = null;
    if (rawJson.trim()) {
      try {
        parsedConfig = JSON.parse(rawJson);
      } catch {
        showToast('Lỗi parse JSON config', 'error');
        return;
      }
    }

    const payload: CreateSupplierSourceDto = {
      name: name.trim(),
      type,
      targetUrl: targetUrl.trim() || null,
      markupPercentage,
      markupFixedVnd,
      configCredentials: parsedConfig,
      isActive,
    };

    setSubmitting(true);
    try {
      if (supplier) {
        await apiClient.patch(`/api/admin/suppliers/${supplier.id}`, payload);
        showToast(`Đã cập nhật nhà cung cấp "${name}"`);
      } else {
        await apiClient.post('/api/admin/suppliers', payload);
        showToast(`Đã tạo nhà cung cấp "${name}"`);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      showToast(err?.message || 'Có lỗi xảy ra khi lưu nhà cung cấp', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl my-8">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
          <div className="flex items-center gap-2 text-slate-100">
            <Code className="w-5 h-5 text-amber-400" />
            <h2 className="text-base font-bold">
              {supplier ? 'Chỉnh sửa nhà cung cấp' : 'Thêm nhà cung cấp mới'}
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
              Tên nhà cung cấp *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="VD: Kho sỉ Digital Pro"
              className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Loại tích hợp
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:border-amber-500"
              >
                <option value="CONFIG_POOL">CONFIG_POOL (Kho key trong Config)</option>
                <option value="WEB_SCRAPER">WEB_SCRAPER (Scraper ngoài / Bot)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Website / Target URL (Tùy chọn)
              </label>
              <input
                type="text"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://..."
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Markup phần trăm (%)
              </label>
              <input
                type="text"
                required
                value={markupPercentage}
                onChange={(e) => setMarkupPercentage(e.target.value)}
                placeholder="10.00"
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 font-mono focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Phụ phí cố định (VND)
              </label>
              <input
                type="text"
                required
                value={markupFixedVnd}
                onChange={(e) => setMarkupFixedVnd(e.target.value)}
                placeholder="5000.00"
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 font-mono focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          {/* Safe JSON Credentials Editor */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Config Credentials (JSON)
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleJsonChange(CONFIG_POOL_PRESET)}
                  className="px-2 py-0.5 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white"
                >
                  Mẫu Pool
                </button>
                <button
                  type="button"
                  onClick={() => handleJsonChange(WEB_SCRAPER_PRESET)}
                  className="px-2 py-0.5 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white"
                >
                  Mẫu Scraper
                </button>
                <button
                  type="button"
                  onClick={handleFormatJson}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-slate-800 text-amber-300 hover:bg-slate-700"
                >
                  <Sparkles className="w-3 h-3" />
                  <span>Format</span>
                </button>
              </div>
            </div>

            <textarea
              rows={6}
              value={rawJson}
              onChange={(e) => handleJsonChange(e.target.value)}
              placeholder='{ "priceMap": {}, "credentialPool": [] }'
              className={`w-full p-3 bg-slate-950 border rounded-xl text-xs text-slate-100 font-mono placeholder:text-slate-700 focus:outline-none transition-colors ${
                jsonError ? 'border-rose-500/80 focus:border-rose-500' : 'border-slate-800 focus:border-amber-500'
              }`}
              spellCheck={false}
            />

            <div className="flex items-center justify-between text-xs">
              {jsonError ? (
                <div className="flex items-center gap-1 text-rose-400">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{jsonError}</span>
                </div>
              ) : (
                <div className="flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Cú pháp JSON hợp lệ</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-800">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded text-amber-500 bg-slate-950 border-slate-700 focus:ring-amber-500"
              />
              <span className="text-xs font-semibold text-slate-200">Hoạt động (Active)</span>
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
                disabled={submitting || Boolean(jsonError)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-xs font-semibold text-slate-950 transition-colors disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
                <span>{submitting ? 'Đang lưu...' : 'Lưu nhà cung cấp'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
