'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { OrderDto } from '@repo/shared-types';
import { apiClient } from '../lib/api-client';

export default function OrderSuccessModal({
  order,
  credential: initialCredential,
  onClose,
}: {
  order: OrderDto;
  credential: string;
  onClose: () => void;
}) {
  const [currentOrder, setCurrentOrder] = useState<OrderDto>(order);
  const [credential, setCredential] = useState<string>(initialCredential);
  const [copied, setCopied] = useState(false);
  const [countdown, setCountdown] = useState<number>(60);

  const isSuccess = currentOrder.status === 'FULFILLED' && credential.length > 0;
  const isRefunded = currentOrder.status === 'REFUNDED';
  const isProcessing =
    currentOrder.status === 'SOURCING' ||
    currentOrder.status === 'PAID' ||
    currentOrder.status === 'PENDING';

  // Haptic feedback on initial open if in SOURCING mode
  useEffect(() => {
    if (isProcessing) {
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
    }
  }, []);

  // 60-second countdown timer for visual progress
  useEffect(() => {
    if (!isProcessing) return;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [isProcessing]);

  // Real-time polling for SOURCING orders
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    if (!isProcessing) return;

    let timeoutId: NodeJS.Timeout;
    const startTime = Date.now();
    const MAX_POLL_DURATION_MS = 75_000; // 75s circuit breaker

    const pollSingleOrder = async () => {
      if (!isMountedRef.current) return;

      try {
        const updated = await apiClient.get<OrderDto>(`/api/orders/${order.id}`);
        if (!isMountedRef.current || !updated) return;

        if (updated.status !== currentOrder.status) {
          setCurrentOrder(updated);

          if (updated.status === 'FULFILLED') {
            if (updated.deliveredCredential) {
              setCredential(updated.deliveredCredential);
            }
            window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
            return; // Terminal state reached
          }

          if (updated.status === 'REFUNDED') {
            window.dispatchEvent(new Event('wallet_refresh'));
            window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('warning');
            return; // Terminal state reached
          }
        }
      } catch {
        // Fallback: poll general orders array if single-order endpoint is unavailable
        try {
          const list = await apiClient.get<OrderDto[]>('/api/orders');
          const found = list?.find((o) => o.id === order.id);
          if (isMountedRef.current && found && found.status !== currentOrder.status) {
            setCurrentOrder(found);
            if (found.status === 'FULFILLED') {
              if (found.deliveredCredential) setCredential(found.deliveredCredential);
              window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
              return;
            }
            if (found.status === 'REFUNDED') {
              window.dispatchEvent(new Event('wallet_refresh'));
              window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('warning');
              return;
            }
          }
        } catch {
          // Network errors are tolerated silently during polling
        }
      }

      if (Date.now() - startTime < MAX_POLL_DURATION_MS && isMountedRef.current) {
        timeoutId = setTimeout(pollSingleOrder, 2500);
      }
    };

    timeoutId = setTimeout(pollSingleOrder, 2500);

    return () => {
      isMountedRef.current = false;
      clearTimeout(timeoutId);
    };
  }, [order.id, isProcessing, currentOrder.status]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(credential);
      setCopied(true);
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
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
          <div className="text-4xl mb-2">
            {isSuccess ? '🎉' : isRefunded ? '🛡️' : isProcessing ? '⏳' : '❌'}
          </div>
          <h2 className="text-base font-bold text-neutral-50">
            {isSuccess
              ? 'Mua hàng thành công!'
              : isRefunded
                ? 'Đã hoàn tiền vào ví'
                : isProcessing
                  ? 'Đơn hàng đang xử lý'
                  : 'Đơn hàng không thành công'}
          </h2>
          <p className="text-xs text-neutral-400 mt-1">Đơn hàng #{currentOrder.id.slice(0, 8)}</p>
        </div>

        {isSuccess ? (
          <div className="rounded-xl bg-neutral-800 p-4">
            <p className="text-xs text-neutral-400 mb-2 font-medium">Key / Tài khoản của bạn</p>
            <p className="text-sm font-mono text-neutral-50 break-all select-all bg-neutral-900 rounded-lg p-3 border border-neutral-700">
              {credential}
            </p>
          </div>
        ) : isRefunded ? (
          <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-4 text-center">
            <p className="text-sm text-amber-300 font-medium">
              Nhà cung cấp tạm hết hàng, hệ thống đã hoàn trả 100% tiền vào ví của bạn.
            </p>
          </div>
        ) : (
          <div className="rounded-xl bg-neutral-800 p-4">
            <p className="text-sm text-neutral-300 text-center mb-3">
              Đang lấy tài khoản từ đối tác (thường mất 15-30s)... Nếu quá 60s, tiền được hoàn lại 100% vào ví.
            </p>
            {/* 60s Countdown Progress Bar */}
            <div className="w-full bg-neutral-700/50 rounded-full h-2 overflow-hidden">
              <div
                className="bg-amber-500 h-2 transition-all duration-1000 ease-linear rounded-full"
                style={{ width: `${Math.max(5, (countdown / 60) * 100)}%` }}
              />
            </div>
            <p className="text-xs text-neutral-400 text-right mt-1.5 font-mono">
              Thời gian tối đa: {countdown}s
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          {isSuccess && (
            <button
              type="button"
              onClick={handleCopy}
              className="flex-1 h-11 rounded-xl bg-blue-600 text-white text-sm font-semibold active:bg-blue-500 transition-colors"
            >
              {copied ? '✓ Đã copy' : 'Copy key'}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-11 rounded-xl bg-neutral-800 text-neutral-300 text-sm font-semibold active:bg-neutral-700 transition-colors"
          >
            {isSuccess || isRefunded ? 'Xong' : 'Đóng (Vẫn xử lý nền)'}
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
