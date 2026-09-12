'use client';

import React, { useState, useEffect } from 'react';
import { KeyRound, ShieldAlert, Check } from 'lucide-react';
import { getAdminApiKey, setAdminApiKey } from '../lib/api-client';

export function AdminKeyModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check on mount
    const key = getAdminApiKey();
    if (!key) {
      setIsOpen(true);
    }

    const onAuthRequired = () => {
      setIsOpen(true);
      setError('Phiên làm việc hết hạn hoặc Admin Key không hợp lệ. Vui lòng nhập lại.');
    };

    const onAuthUpdated = () => {
      setIsOpen(false);
      setError(null);
    };

    window.addEventListener('admin_auth_required', onAuthRequired);
    window.addEventListener('admin_auth_updated', onAuthUpdated);

    return () => {
      window.removeEventListener('admin_auth_required', onAuthRequired);
      window.removeEventListener('admin_auth_updated', onAuthUpdated);
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyInput || keyInput.trim().length < 16) {
      setError('Admin API Key phải có độ dài tối thiểu 16 ký tự (khuyến nghị 32 ký tự trở lên)');
      return;
    }

    setAdminApiKey(keyInput);
    setIsOpen(false);
    setKeyInput('');
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95">
        <div className="flex items-center gap-3 mb-4 text-amber-400">
          <div className="p-2.5 bg-amber-500/10 rounded-xl border border-amber-500/20">
            <KeyRound className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-100">Xác thực Quản trị viên</h2>
            <p className="text-xs text-slate-400">Nhập Admin API Key để truy cập bảng điều khiển</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center gap-2 text-xs text-rose-300">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Admin API Key (Secret)
            </label>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Nhập secret key (tối thiểu 32 ký tự)..."
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 font-mono"
              autoFocus
            />
          </div>

          <div className="pt-1">
            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-slate-950 font-semibold rounded-xl text-sm transition-colors shadow-lg shadow-amber-500/20"
            >
              <Check className="w-4 h-4" />
              <span>Xác nhận & Đăng nhập</span>
            </button>
          </div>
        </form>

        <p className="mt-4 text-center text-[11px] text-slate-500">
          Key được lưu tạm trong SessionStorage và không bao giờ commit vào client source code.
        </p>
      </div>
    </div>
  );
}
