'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { OrderDto } from '@repo/shared-types';

export default function OrderSuccessModal({
  order,
  credential,
  onClose,
}: {
  order: OrderDto;
  credential: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(credential);
      setCopied(true);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older WebView
      const ta = document.createElement('textarea');
      ta.value = credential;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="fixed bottom-0 inset-x-0 z-50 rounded-t-2xl bg-neutral-900 border-t border-neutral-800 p-5 pb-8 flex flex-col gap-4">
        <div className="w-10 h-1 rounded-full bg-neutral-700 mx-auto" />

        <div className="text-center">
          <div className="text-4xl mb-2">🎉</div>
          <h2 className="text-base font-bold text-neutral-50">Mua hàng thành công!</h2>
          <p className="text-xs text-neutral-400 mt-1">Đơn hàng #{order.id.slice(0, 8)}</p>
        </div>

        {/* Credential box */}
        <div className="rounded-xl bg-neutral-800 p-4">
          <p className="text-xs text-neutral-400 mb-2 font-medium">Key / Tài khoản của bạn</p>
          <p className="text-sm font-mono text-neutral-50 break-all select-all bg-neutral-900 rounded-lg p-3 border border-neutral-700">
            {credential}
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleCopy}
            className="flex-1 h-11 rounded-xl bg-blue-600 text-white text-sm font-semibold active:bg-blue-500 transition-colors"
          >
            {copied ? '✓ Đã copy' : 'Copy key'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-11 rounded-xl bg-neutral-800 text-neutral-300 text-sm font-semibold active:bg-neutral-700 transition-colors"
          >
            Xong
          </button>
        </div>

        <Link
          href="/orders"
          onClick={() =>
            window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light')
          }
          className="block text-center text-sm text-blue-400 active:text-blue-300 py-1"
        >
          Xem đơn hàng →
        </Link>
      </div>
    </>
  );
}
