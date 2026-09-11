'use client';

import { useState } from 'react';
import type { CatalogProductDto } from '@repo/shared-types';
import { ProductStockStatus } from '@repo/shared-types';

function formatVnd(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '0 ₫';
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);
}

const CATEGORY_EMOJI: Record<string, string> = {
  'AI Tools': '🤖',
  'Dev Tools': '🛠️',
  'Office': '📄',
  'Giải trí': '🎬',
};

export default function ProductCard({
  product,
  onBuy,
}: {
  product: CatalogProductDto;
  onBuy: (p: CatalogProductDto) => void;
}) {
  const [imgError, setImgError] = useState(false);
  const inStock = product.stockStatus === ProductStockStatus.IN_STOCK;
  const emoji = CATEGORY_EMOJI[product.category ?? ''] ?? '📦';
  const initial = product.title?.trim()?.charAt(0)?.toUpperCase() || '📦';

  const handleBuy = () => {
    if (!inStock) return;
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium');
    onBuy(product);
  };

  return (
    <div className="rounded-xl bg-neutral-900 border border-neutral-800 p-3 flex flex-col gap-2">
      {/* Thumbnail 1:1 */}
      <div className="aspect-square rounded-xl bg-neutral-800 flex items-center justify-center overflow-hidden">
        {product.imageUrl && !imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.title}
            onError={() => setImgError(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-4xl" aria-hidden>
            {emoji !== '📦' ? emoji : initial}
          </span>
        )}
      </div>

      {/* Title — max 2 lines */}
      <p className="text-sm font-medium text-neutral-100 leading-snug line-clamp-2 min-h-[2.5rem]">
        {product.title}
      </p>

      {/* Price + stock badge */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-neutral-50">{formatVnd(product.price)}</span>
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${
            inStock ? 'bg-emerald-500/15 text-emerald-400' : 'bg-neutral-700/60 text-neutral-400'
          }`}
        >
          {inStock ? 'Còn hàng' : 'Hết hàng'}
        </span>
      </div>

      {/* Buy button — ≥44px touch target */}
      <button
        type="button"
        onClick={handleBuy}
        disabled={!inStock}
        className={`h-11 rounded-xl text-sm font-semibold transition-colors ${
          inStock
            ? 'bg-blue-600 text-white active:bg-blue-500'
            : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
        }`}
      >
        {inStock ? 'Mua ngay' : 'Hết hàng'}
      </button>
    </div>
  );
}
