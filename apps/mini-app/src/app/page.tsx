'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/api-client';
import type { CatalogProductDto, CatalogResponseDto, OrderDto } from '@repo/shared-types';
import ProductCard from '../components/ProductCard';
import SearchBar from '../components/SearchBar';
import CategoryFilter from '../components/CategoryFilter';
import BalanceHeader from '../components/BalanceHeader';
import CheckoutModal from '../components/CheckoutModal';
import OrderSuccessModal from '../components/OrderSuccessModal';

function removeVietnameseDiacritics(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function SkeletonCard() {
  return (
    <div className="rounded-xl bg-neutral-900 border border-neutral-800 p-3 flex flex-col gap-2 animate-pulse">
      <div className="aspect-square rounded-xl bg-neutral-800" />
      <div className="h-8 rounded bg-neutral-800" />
      <div className="h-5 rounded bg-neutral-800 w-2/3" />
      <div className="h-11 rounded-xl bg-neutral-800" />
    </div>
  );
}

export default function HomePage() {
  const [products, setProducts] = useState<CatalogProductDto[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutProduct, setCheckoutProduct] = useState<CatalogProductDto | null>(null);
  const [orderResult, setOrderResult] = useState<{ order: OrderDto; credential: string } | null>(null);
  const [walletBalance, setWalletBalance] = useState<string>('0');
  const [telegramUser, setTelegramUser] = useState<{
    firstName: string;
    username?: string;
    photoUrl?: string;
  } | null>(null);

  useEffect(() => {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
    const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
    // Fetch wallet balance for checkout modal
    apiClient
      .get<{ ok: boolean; wallet: { balance: string } }>('/api/wallets/me')
      .then((res) => {
        if (res?.ok && res.wallet?.balance) setWalletBalance(res.wallet.balance);
      })
      .catch(() => {});
    if (user?.first_name) {
      setTelegramUser({
        firstName: user.first_name,
        username: user.username,
        photoUrl: user.photo_url,
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient
      .get<CatalogResponseDto>('/api/products')
      .then((res) => {
        if (cancelled) return;
        if (!res || !res.ok) {
          setError('Không tải được danh mục');
          return;
        }
        setProducts(res.products ?? []);
        setError(null);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setError(err?.message || 'Không tải được danh mục');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = useMemo(
    () =>
      Array.from(
        new Set(
          products
            .map((p) => p.category)
            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            .map((c) => c.trim()),
        ),
      ),
    [products],
  );

  const filtered = useMemo(() => {
    const rawQ = query.trim();
    const normQ = removeVietnameseDiacritics(rawQ);
    return products.filter((p) => {
      const matchesCategory = category === null || p.category === category;
      if (!matchesCategory) return false;
      if (!rawQ) return true;
      const titleLower = p.title.toLowerCase();
      const normTitle = removeVietnameseDiacritics(p.title);
      return titleLower.includes(rawQ.toLowerCase()) || normTitle.includes(normQ);
    });
  }, [products, query, category]);

  // When viewing "All" without a specific category filter, group products by category section.
  const groupedSections = useMemo(() => {
    if (category !== null) return null;
    const sections: { category: string; items: CatalogProductDto[] }[] = [];
    for (const cat of categories) {
      const items = filtered.filter((p) => p.category === cat);
      if (items.length > 0) {
        sections.push({ category: cat, items });
      }
    }
    const uncategorized = filtered.filter((p) => !p.category || !categories.includes(p.category));
    if (uncategorized.length > 0) {
      sections.push({ category: 'Khác', items: uncategorized });
    }
    return sections;
  }, [category, categories, filtered]);

  const handleBuy = (p: CatalogProductDto) => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
    setCheckoutProduct(p);
  };

  const handleCheckoutSuccess = (order: OrderDto, credential: string) => {
    setCheckoutProduct(null);
    setOrderResult({ order, credential });
    // Refresh balance after purchase
    apiClient
      .get<{ ok: boolean; wallet: { balance: string } }>('/api/wallets/me')
      .then((res) => {
        if (res?.ok && res.wallet?.balance) setWalletBalance(res.wallet.balance);
      })
      .catch(() => {});
  };

  return (
    <main className="min-h-screen pb-20">
      {/* Sticky header: avatar/name + balance widget */}
      <header className="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur px-4 h-14 flex items-center justify-between border-b border-neutral-900">
        <div className="flex items-center gap-2.5">
          {telegramUser?.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={telegramUser.photoUrl}
              alt=""
              className="w-8 h-8 rounded-full object-cover border border-neutral-800"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center text-xs font-semibold text-neutral-300">
              {telegramUser?.firstName ? telegramUser.firstName.charAt(0).toUpperCase() : '🛒'}
            </div>
          )}
          <div className="flex flex-col">
            <span className="text-sm font-bold text-neutral-100 leading-tight">
              {telegramUser?.firstName || 'Cửa hàng'}
            </span>
            {telegramUser?.username && (
              <span className="text-[11px] text-neutral-400 leading-tight">
                @{telegramUser.username}
              </span>
            )}
          </div>
        </div>
        <BalanceHeader />
      </header>

      <div className="px-4 pt-4 flex flex-col gap-3">
        <SearchBar value={query} onChange={setQuery} />
        <CategoryFilter categories={categories} selected={category} onChange={setCategory} />

        {error ? (
          <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-4 text-sm text-red-300">
            {error}
          </div>
        ) : loading ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-neutral-500 text-sm py-10">
            Không tìm thấy sản phẩm phù hợp.
          </p>
        ) : groupedSections ? (
          <div className="flex flex-col gap-6">
            {groupedSections.map((sec) => (
              <section key={sec.category} className="flex flex-col gap-2.5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                  {sec.category}
                </h2>
                <div className="grid grid-cols-2 gap-3">
                  {sec.items.map((p) => (
                    <ProductCard key={p.id} product={p} onBuy={handleBuy} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map((p) => (
              <ProductCard key={p.id} product={p} onBuy={handleBuy} />
            ))}
          </div>
        )}
      </div>

      {checkoutProduct && (
        <CheckoutModal
          product={checkoutProduct}
          balance={walletBalance}
          onClose={() => setCheckoutProduct(null)}
          onSuccess={handleCheckoutSuccess}
        />
      )}

      {orderResult && (
        <OrderSuccessModal
          order={orderResult.order}
          credential={orderResult.credential}
          onClose={() => setOrderResult(null)}
        />
      )}
    </main>
  );
}
