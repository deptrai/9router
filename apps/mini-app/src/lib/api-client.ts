'use client';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/**
 * Attempts to retrieve Telegram WebApp initData from multiple sources.
 * Priority:
 * 1. window.Telegram.WebApp.initData (real Telegram WebView)
 * 2. URL hash parameter #tgWebAppData=<...> or query string ?tgWebAppData=<...>
 * 3. process.env.NEXT_PUBLIC_DEV_TG_INIT_DATA (local development fallback)
 */
export function getTelegramInitData(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  // Source 1: real Telegram WebView
  const tgInitData = window.Telegram?.WebApp?.initData;
  if (tgInitData) {
    return tgInitData;
  }

  // Source 2: global fallback (legacy loader / custom dev shim)
  const globalInitData = window.__telegramInitData;
  if (globalInitData) {
    return globalInitData;
  }

  // Source 3: URL hash or search parameters
  const rawHash = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
  const hashParams = new URLSearchParams(rawHash);
  const rawSearch = window.location.search ? window.location.search.replace(/^\?/, '') : '';
  const searchParams = new URLSearchParams(rawSearch);

  const fromUrl =
    hashParams.get('tgWebAppData') || searchParams.get('tgWebAppData');
  if (fromUrl) {
    return fromUrl;
  }

  // Source 4: NEXT_PUBLIC_DEV_TG_INIT_DATA for localhost dev
  if (process.env.NEXT_PUBLIC_DEV_TG_INIT_DATA) {
    return process.env.NEXT_PUBLIC_DEV_TG_INIT_DATA;
  }

  return null;
}

/**
 * Wrapper around fetch() that automatically attaches Telegram WebApp initData
 * in the Authorization header when running in a Telegram WebView.
 */
export async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const initData = getTelegramInitData();

  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');

  if (initData) {
    headers.set('Authorization', `tma ${initData}`);
  }

  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

  return fetch(url, {
    ...options,
    headers,
  });
}

/**
 * Convenience helper for GET requests returning JSON.
 */
export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: 'GET' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error?.message || `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}
