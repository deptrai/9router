'use client';

import { useEffect, useState } from 'react';
import { apiClient, getTelegramInitData } from '../lib/api-client';
import type { TelegramUserDto } from '@repo/shared-types';

export default function HomePage() {
  const [initData, setInitData] = useState<string | null>(null);
  const [user, setUser] = useState<TelegramUserDto | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.Telegram?.WebApp?.ready();

    const init = getTelegramInitData();
    setInitData(init);

    if (init) {
      setLoading(true);
      apiClient.get<{ ok: boolean; user: TelegramUserDto }>('/api/auth/me')
        .then((res) => {
          setUser(res.user);
          setAuthError(null);
        })
        .catch((err: any) => {
          setAuthError(err?.message || 'Authentication failed');
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
      setAuthError('No Telegram initData available');
    }
  }, []);

  return (
    <main className="p-4 flex flex-col items-center justify-start min-h-screen text-center">
      <h1 className="text-2xl font-bold mb-2">9Router Telegram Store</h1>

      <div className="w-full max-w-sm rounded-xl bg-neutral-900 border border-neutral-800 p-4 mt-4">
        <p className="text-neutral-300 text-sm font-semibold mb-2">Telegram Auth Probe</p>

        {loading ? (
          <p className="text-neutral-400 text-sm">Verifying Telegram identity...</p>
        ) : authError ? (
          <div className="text-left">
            <p className="text-red-400 text-sm">{authError}</p>
            {initData && (
              <p className="text-neutral-500 text-xs mt-2 break-all">
                initData length: {initData.length} chars
              </p>
            )}
          </div>
        ) : user ? (
          <div className="text-left">
            <p className="text-emerald-400 text-sm font-semibold">Authenticated</p>
            <p className="text-neutral-300 text-sm mt-1">Name: {user.firstName} {user.lastName || ''}</p>
            <p className="text-neutral-400 text-xs">ID: {user.id}</p>
            {user.username && (
              <p className="text-neutral-400 text-xs">@{user.username}</p>
            )}
          </div>
        ) : (
          <p className="text-neutral-400 text-sm">Open this Mini App inside Telegram to authenticate.</p>
        )}
      </div>

      <div className="w-full max-w-sm rounded-xl bg-neutral-900 border border-neutral-800 p-4 mt-4">
        <p className="text-neutral-300 text-sm">Mini App Skeleton Ready</p>
      </div>
    </main>
  );
}
