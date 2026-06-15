"use client";

import { create } from "zustand";
import { CLIENT_STORE_TTL_MS } from "@/shared/constants/config";
import { dedupFetch } from "@/shared/utils/requestDedup";

const useAuthStore = create((set, get) => ({
  role: null,
  displayName: "",
  loginMethod: "",
  loading: false,
  error: null,
  lastFetched: 0,

  invalidate: () => set({ lastFetched: 0 }),

  fetchAuthStatus: async ({ force = false } = {}) => {
    const { lastFetched } = get();
    if (!force && lastFetched && Date.now() - lastFetched < CLIENT_STORE_TTL_MS) return;
    set({ loading: true, error: null });
    try {
      const res = await dedupFetch("/api/auth/status");
      const data = await res.json();
      if (res.ok) {
        set({
          role: data.role ?? "admin",
          displayName: data?.displayName || data?.oidcName || data?.oidcEmail || "",
          loginMethod: data?.loginMethod || "",
          loading: false,
          lastFetched: Date.now(),
        });
      } else {
        set({ role: "admin", loading: false, lastFetched: Date.now() });
      }
    } catch {
      set({ role: "admin", loading: false, lastFetched: Date.now() });
    }
  },
}));

export default useAuthStore;
