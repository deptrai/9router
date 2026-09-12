'use client';

import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import type { OrderDto } from '@repo/shared-types';
import { OrderStatus } from '@repo/shared-types';

function StatusBadge({ status }: { status: OrderStatus }) {
  const cls =
    status === OrderStatus.FULFILLED
      ? 'bg-green-600/20 text-green-400 border border-green-500/30'
      : status === OrderStatus.REFUNDED
        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
        : status === OrderStatus.PENDING ||
            status === OrderStatus.PAID ||
            status === OrderStatus.SOURCING
          ? 'bg-yellow-600/20 text-yellow-400 border border-yellow-500/30'
          : 'bg-red-600/20 text-red-400 border border-red-500/30';

  const label =
    status === OrderStatus.REFUNDED
      ? 'ĐÃ HOÀN TIỀN'
      : status === OrderStatus.SOURCING
        ? 'ĐANG LẤY HÀNG'
        : status;

  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function CredentialBox({ credential }: { credential: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(credential);
    } catch {
      // Fallback for older WebView
      const el = document.createElement('textarea');
      el.value = credential;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-2">
      <p className="text-xs text-neutral-400 mb-1">Credential</p>
      <div className="flex items-center gap-2 bg-neutral-800 rounded-lg px-3 py-2">
        <code className="flex-1 text-xs text-neutral-200 font-mono truncate">
          {credential}
        </code>
        <button
          onClick={handleCopy}
          className={`shrink-0 px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
            copied
              ? 'bg-green-600 text-white'
              : 'bg-blue-600 text-white active:bg-blue-500'
          }`}
        >
          {copied ? '✓ Đã copy' : 'Sao chép'}
        </button>
      </div>
      <p className="text-xs text-neutral-500 mt-1">
        Sử dụng key/tài khoản trên để kích hoạt sản phẩm.
      </p>
    </div>
  );
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ordersRef = useRef<OrderDto[] | null>(null);
  ordersRef.current = orders;

  useEffect(() => {
    let cancelled = false;
    const fetchOrders = async () => {
      try {
        const data = await apiClient.get<OrderDto[]>('/api/orders');
        if (!cancelled) {
          setOrders(data);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Không tải được đơn hàng');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    fetchOrders();

    // Refetch on window focus + light polling while any order is SOURCING
    // so a fulfilled-later order updates without manual reload.
    const onFocus = () => fetchOrders();
    window.addEventListener('focus', onFocus);
    const interval = setInterval(() => {
      if (ordersRef.current?.some((o) => o.status === 'SOURCING')) {
        fetchOrders();
      }
    }, 5000);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 pb-20">
      <div className="px-4 pt-6 pb-4">
        <h1 className="text-xl font-bold">Đơn hàng của tôi</h1>
      </div>

      {loading && (
        <div className="px-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-neutral-900 border border-neutral-800 rounded-xl p-3 animate-pulse"
            >
              <div className="h-4 bg-neutral-800 rounded w-2/3 mb-2" />
              <div className="h-3 bg-neutral-800 rounded w-1/3" />
            </div>
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="px-4">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {!loading && !error && orders && orders.length === 0 && (
        <div className="px-4 py-12 text-center">
          <p className="text-neutral-400 text-sm">Bạn chưa có đơn hàng nào.</p>
        </div>
      )}

      {!loading && !error && orders && orders.length > 0 && (
        <div className="px-4 space-y-3">
          {orders.map((order) => (
            <div
              key={order.id}
              className="bg-neutral-900 border border-neutral-800 rounded-xl p-3"
            >
              <div className="flex items-start justify-between mb-1">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {order.productTitle ?? order.productId}
                  </p>
                  <p className="text-xs text-neutral-500">
                    #{order.id.slice(0, 8)}
                  </p>
                </div>
                <StatusBadge status={order.status} />
              </div>

              <p className="text-xs text-neutral-400 mt-1">
                {new Date(order.createdAt).toLocaleDateString('vi-VN')}
              </p>
              <p className="text-sm font-medium text-neutral-200 mt-0.5">
                {order.price} VND
              </p>

              {order.status === 'SOURCING' && (
                <p className="text-xs text-neutral-500 mt-1">
                  Đang lấy hàng từ nhà cung cấp ngoài…
                </p>
              )}

              {order.status === 'REFUNDED' && (
                <div className="mt-2 rounded-lg bg-amber-500/10 border border-amber-500/20 p-2.5">
                  <p className="text-xs text-amber-300 font-medium">
                    Đã hoàn lại 100% tiền vào ví do nhà cung cấp không phản hồi hoặc quá 60s.
                  </p>
                </div>
              )}

              {order.status === 'FULFILLED' && order.deliveredCredential && (
                <CredentialBox credential={order.deliveredCredential} />
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
