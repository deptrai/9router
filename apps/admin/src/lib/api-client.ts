'use client';

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3201').replace(/\/+$/, '');

export function getAdminApiKey(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.sessionStorage?.getItem('admin_api_key');
  if (stored && stored.trim()) {
    return stored.trim();
  }
  if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DEV_ADMIN_KEY) {
    return process.env.NEXT_PUBLIC_DEV_ADMIN_KEY;
  }
  return null;
}

export function setAdminApiKey(key: string): void {
  if (typeof window !== 'undefined') {
    window.sessionStorage?.setItem('admin_api_key', key.trim());
    window.dispatchEvent(new Event('admin_auth_updated'));
  }
}

export function clearAdminApiKey(): void {
  if (typeof window !== 'undefined') {
    window.sessionStorage?.removeItem('admin_api_key');
    window.dispatchEvent(new Event('admin_auth_required'));
  }
}

export function getTelegramInitData(): string | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as any).Telegram?.WebApp?.initData ||
    (process.env.NODE_ENV === 'development' ? process.env.NEXT_PUBLIC_DEV_TG_INIT_DATA : null) ||
    null
  );
}

export async function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const adminKey = getAdminApiKey();
  const initData = getTelegramInitData();

  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (adminKey) {
    headers.set('x-admin-key', adminKey);
  } else if (initData) {
    headers.set('Authorization', `tma ${initData}`);
  }

  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401 || response.status === 403) {
    clearAdminApiKey();
  }

  return response;
}

export async function adminGet<T = any>(path: string): Promise<T> {
  const res = await adminFetch(path, { method: 'GET' });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody?.message || `Request failed with status ${res.status}`);
    (err as any).status = res.status;
    (err as any).body = errBody;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function adminPost<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await adminFetch(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody?.message || `Request failed with status ${res.status}`);
    (err as any).status = res.status;
    (err as any).body = errBody;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function adminPatch<T = any>(path: string, body: unknown): Promise<T> {
  const res = await adminFetch(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody?.message || `Request failed with status ${res.status}`);
    (err as any).status = res.status;
    (err as any).body = errBody;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function adminDelete<T = any>(path: string): Promise<T> {
  const res = await adminFetch(path, { method: 'DELETE' });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody?.message || `Request failed with status ${res.status}`);
    (err as any).status = res.status;
    (err as any).body = errBody;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const apiClient = {
  get: adminGet,
  post: adminPost,
  patch: adminPatch,
  delete: adminDelete,
  fetch: adminFetch,
};
