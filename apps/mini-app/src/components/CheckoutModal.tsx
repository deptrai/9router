'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CatalogProductDto, CheckoutResponseDto, OrderDto } from '@repo/shared-types';
import { apiClient } from '../lib/api-client';

function formatVnd(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '0 ₫';
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);
}

type CheckoutState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'insufficient'; missingAmount: string }
  | { kind: 'out-of-stock' }
  | { kind: 'error'; message: string };

export default function CheckoutModal({
  product,
  balance,
  onClose,
  onSuccess,
}: {
  product: CatalogProductDto;
  balance: string;
  onClose: () => void;
  onSuccess: (order: OrderDto, credential: string) => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<CheckoutState>({ kind: 'idle' });
  // Generate idempotencyKey once per modal open — retries reuse the same key
  // so a dropped response doesn't create a duplicate order on retry.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const balanceNum = Number(balance);
  const priceNum = Number(product.price);
  const canAfford = balanceNum >= priceNum;
  const missing = !canAfford ? formatVnd(priceNum - balanceNum) : null;

  const handleConfirm = async () => {
    if (!canAfford) {
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
      router.push('/topup');
      return;
    }

    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium');
    setState({ kind: 'loading' });

    try {
      const res = await apiClient.fetch('/api/orders/checkout', {
        method: 'POST',
        body: JSON.stringify({ productId: product.id, idempotencyKey }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 402 || body?.errorCode === 'INSUFFICIENT_FUNDS') {
          setState({ kind: 'insufficient', missingAmount: body?.missingAmount ?? missing ?? '' });
        } else if (res.status === 409 && body?.errorCode === 'OUT_OF_STOCK') {
          setState({ kind: 'out-of-stock' });
        } else if (res.status === 409) {
          setState({ kind: 'error', message: 'Đơn hàng đang được xử lý. Vui lòng thử lại.' });
        } else {
          setState({ kind: 'error', message: body?.message ?? 'Có lỗi xảy ra. Vui lòng thử lại.' });
        }
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
        return;
      }

      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
      onSuccess(body.order, body.deliveredCredential ?? '');
    } catch (err: any) {
      setState({ kind: 'error', message: err?.message ?? 'Có lỗi xảy ra. Vui lòng thử lại.' });
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      {/* Bottom sheet */}
      <div className="fixed bottom-0 inset-x-0 z-50 rounded-t-2xl bg-neutral-900 border-t border-neutral-800 p-5 pb-8 flex flex-col gap-4">
        {/* Handle */}
        <div className="w-10 h-1 rounded-full bg-neutral-700 mx-auto" />

        <h2 className="text-base font-bold text-neutral-50 text-center">Xác nhận mua hàng</h2>

        {/* Product summary */}
        <div className="rounded-xl bg-neutral-800 p-4 flex flex-col gap-2">
          <p className="text-sm font-semibold text-neutral-100 line-clamp-2">{product.title}</p>
          <div className="flex justify-between items-center">
            <span className="text-xs text-neutral-400">Giá</span>
            <span className="text-sm font-bold text-neutral-50">{formatVnd(product.price)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-neutral-400">Số dư ví</span>
            <span className={`text-sm font-semibold ${canAfford ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatVnd(balance)}
            </span>
          </div>
          {missing && (
            <div className="flex justify-between items-center border-t border-neutral-700 pt-2">
              <span className="text-xs text-red-400">Còn thiếu</span>
              <span className="text-sm font-bold text-red-400">{missing}</span>
            </div>
          )}
        </div>

        {/* Error states */}
        {state.kind === 'insufficient' && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-center">
            <p className="text-sm text-red-400">
              Số dư không đủ — còn thiếu{' '}
              <span className="font-bold">{formatVnd(state.missingAmount)}</span>
            </p>
            <a href="/topup" className="text-xs text-blue-400 underline mt-1 inline-block">
              Nạp thêm tiền →
            </a>
          </div>
        )}
        {state.kind === 'out-of-stock' && (
          <div className="rounded-xl bg-neutral-800 border border-neutral-700 p-3 text-center">
            <p className="text-sm text-neutral-400">Sản phẩm đã hết hàng</p>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-center">
            <p className="text-sm text-red-400">{state.message}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={state.kind === 'loading'}
            className="flex-1 h-11 rounded-xl bg-neutral-800 text-neutral-300 text-sm font-semibold active:bg-neutral-700 transition-colors disabled:opacity-50"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={state.kind === 'loading' || state.kind === 'out-of-stock'}
            className={`flex-1 h-11 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 ${
              canAfford && state.kind !== 'out-of-stock'
                ? 'bg-blue-600 text-white active:bg-blue-500'
                : 'bg-neutral-800 text-neutral-500'
            }`}
          >
            {state.kind === 'loading' ? 'Đang xử lý...' : !canAfford ? 'Nạp thêm tiền' : 'Xác nhận'}
          </button>
        </div>
      </div>
    </>
  );
}
