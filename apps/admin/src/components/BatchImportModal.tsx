'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { X, Upload, AlertTriangle, CheckCircle } from 'lucide-react';
import type { ProductDto } from '@repo/shared-types';

interface BatchImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  product: ProductDto | null;
  onSubmit: (credentials: string[]) => Promise<void>;
}

export function BatchImportModal({
  isOpen,
  onClose,
  onSuccess,
  product,
  onSubmit,
}: BatchImportModalProps) {
  const [rawText, setRawText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setRawText('');
      setError(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  // Parse and count valid lines
  const { validLines, invalidLines, commentLines } = useMemo(() => {
    if (!rawText.trim()) {
      return { validLines: [], invalidLines: [], commentLines: [] };
    }

    const normalized = rawText.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const valid: string[] = [];
    const invalid: string[] = [];
    const comments: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        invalid.push(line);
      } else if (trimmed.startsWith('#')) {
        comments.push(trimmed);
      } else {
        valid.push(trimmed);
      }
    }

    return { validLines: valid, invalidLines: invalid, commentLines: comments };
  }, [rawText]);

  // Check if product accepts inventory
  const canImport = useMemo(() => {
    if (!product) return { ok: false, reason: 'Chưa chọn sản phẩm' };
    if (!product.isActive) return { ok: false, reason: 'Sản phẩm đang tạm ngưng' };
    if (product.sourcingMode === 'EXTERNAL') {
      return { ok: false, reason: 'Sản phẩm EXTERNAL không nhận kho nội bộ' };
    }
    return { ok: true };
  }, [product]);

  const handleSubmit = async () => {
    if (!product || validLines.length === 0) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await onSubmit(validLines);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Có lỗi xảy ra khi nhập lô');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-lg font-bold text-slate-100">Nhập lô Credential</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {product?.title || 'Chưa chọn sản phẩm'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto max-h-[calc(90vh-140px)]">
          {/* Warning banner if cannot import */}
          {!canImport.ok && (
            <div className="flex items-start gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20">
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-rose-400">Không thể nhập kho</p>
                <p className="text-xs text-rose-300/80 mt-1">{canImport.reason}</p>
              </div>
            </div>
          )}

          {/* Textarea */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-2">
              Dán danh sách credential (mỗi dòng 1 credential)
            </label>
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={`Nhập credentials, ví dụ:
user@example.com:password123
XXXX-YYYY-ZZZZ
license-key-here`}
              disabled={!canImport.ok}
              className="w-full h-48 px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/20 resize-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          {/* Line counter */}
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span className="text-slate-300">
                <span className="font-mono font-semibold text-emerald-400">{validLines.length}</span> dòng hợp lệ
              </span>
            </div>
            {invalidLines.length > 0 && (
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span className="text-slate-400">
                  <span className="font-mono">{invalidLines.length}</span> dòng trống
                </span>
              </div>
            )}
            {commentLines.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500">
                  <span className="font-mono">{commentLines.length}</span> dòng comment (#)
                </span>
              </div>
            )}
          </div>

          {/* Error message */}
          {error && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20">
              <p className="text-xs text-rose-400">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            Hủy
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canImport.ok || validLines.length === 0 || isSubmitting}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload className="w-4 h-4" />
            <span>{isSubmitting ? 'Đang nhập...' : `Nhập ${validLines.length} credential`}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
