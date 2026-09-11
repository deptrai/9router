'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiClient } from '../lib/api-client';

function formatVnd(value: number): string {
  if (!Number.isFinite(value)) return '0 ₫';
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(value);
}

/**
 * Balance Header Widget (UX spec): wallet icon + VND balance + quick top-up "+".
 * Whole pill is clickable to open top-up, with minimum 44px height touch target.
 * Hidden when auth fails so it never blocks the catalog.
 */
export default function BalanceHeader() {
  const [balance, setBalance] = useState<number | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const fetchBalance = async (isMounted: () => boolean) => {
    try {
      const res = await apiClient.get<{ ok: boolean; wallet?: { balance: string } }>('/api/wallets/me');
      if (!isMounted()) return;
      if (res?.wallet?.balance !== undefined) {
        setBalance(Number(res.wallet.balance));
      }
    } catch {
      if (isMounted()) {
        setUnauthorized(true);
      }
    }
  };

  useEffect(() => {
    let mounted = true;
    const isMounted = () => mounted;

    fetchBalance(isMounted);

    // Refresh balance when user returns to tab/window or on custom wallet refresh events
    const onFocus = () => fetchBalance(isMounted);
    window.addEventListener('focus', onFocus);
    window.addEventListener('wallet_refresh', onFocus);

    // Refresh periodically every 15s when active
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchBalance(isMounted);
      }
    }, 15000);

    return () => {
      mounted = false;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('wallet_refresh', onFocus);
      clearInterval(interval);
    };
  }, []);

  if (unauthorized) return null;

  return (
    <Link
      href="/topup"
      aria-label="Nạp tiền vào ví"
      className="flex items-center gap-2 rounded-full bg-neutral-900 border border-neutral-800 pl-3 pr-1 h-11 transition-colors hover:border-neutral-700 active:bg-neutral-800"
    >
      <span className="text-sm" aria-hidden>💳</span>
      <span className="text-sm font-semibold text-emerald-400">
        {balance === null ? '…' : formatVnd(balance)}
      </span>
      <span
        aria-hidden
        className="ml-1 w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center text-lg font-bold pointer-events-none"
      >
        +
      </span>
    </Link>
  );
}
