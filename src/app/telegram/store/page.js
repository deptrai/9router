"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export default function TelegramStorePage() {
  const [products, setProducts] = useState([]);
  const [user, setUser] = useState(null);
  const [balances, setBalances] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [buyingId, setBuyingId] = useState(null);
  const [webAppReady, setWebAppReady] = useState(false);
  const initDataRef = useRef("");

  // Lấy initData từ URL/global trước khi render, không phụ thuộc SDK.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const rawHash = window.location.hash ? window.location.hash.replace(/^#/, "") : "";
    const hashParams = new URLSearchParams(rawHash);
    const rawSearch = window.location.search ? window.location.search.replace(/^\?/, "") : "";
    const searchParams = new URLSearchParams(rawSearch);
    const initData =
      (typeof window !== "undefined" ? window.__telegramInitData : "") ||
      hashParams.get("tgWebAppData") ||
      searchParams.get("tgWebAppData") ||
      "";
    initDataRef.current = initData;
  }, []);

  // Load SDK Telegram WebApp để có ready(), expand(), sendData().
  useEffect(() => {
    if (typeof window === "undefined") return;

    const setupWebApp = () => {
      const tg = window.Telegram?.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
        setWebAppReady(true);
      }
    };

    if (window.Telegram?.WebApp) {
      setupWebApp();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.defer = true;
    script.onload = setupWebApp;
    script.onerror = () => {
      console.error("[telegram/store] Không tải được Telegram WebApp SDK.");
    };
    document.head.appendChild(script);
  }, []);

  // Tải sản phẩm + validate initData; không phụ thuộc Telegram SDK.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    const attempt = async () => {
      const initData = initDataRef.current;

      try {
        let init = null;
        if (initData) {
          const res = await fetch("/api/telegram/validate-init-data", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ initData }),
          });
          init = await res.json();
          if (res.ok && init.ok) {
            setUser(init.user);
          } else {
            console.error("[telegram/store] validate error:", init.error);
          }
        }

        const [productsRes, userInfoRes] = await Promise.all([
          fetch("/api/store/products"),
          init?.user?.id && initData
            ? fetch("/api/telegram/user-info", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ initData }),
              })
            : null,
        ]);

        const productsData = await productsRes.json();
        setProducts(productsData.products || []);

        if (userInfoRes) {
          const userInfo = await userInfoRes.json();
          if (userInfo.ok) {
            setBalances(userInfo.balances);
          }
        }
      } catch (e) {
        console.error("[telegram/store] load error:", e?.message);
        setError(e?.message || "Không thể tải cửa hàng");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    attempt();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? products.filter((p) =>
          `${p.name} ${p.description || ""}`.toLowerCase().includes(q)
        )
      : products;
  }, [products, search]);

  const isProductAvailable = (p) => {
    if (!p.isActive) return false;
    if (p.stock !== null && p.stock !== undefined && p.stock <= 0) return false;
    return true;
  };

  const handleBuy = (productId) => {
    if (typeof window === "undefined") return;
    const tg = window.Telegram?.WebApp;
    if (!tg) {
      console.error("[telegram/store] Telegram WebApp chưa sẵn sàng.");
      return;
    }
    if (!initDataRef.current) {
      tg.showAlert?.("Không nhận được dữ liệu Telegram. Vui lòng mở lại từ bot.");
      return;
    }
    setBuyingId(productId);
    tg.sendData(JSON.stringify({ action: "buy", productId }));
  };

  const totalCredits = useMemo(() => {
    if (!balances) return null;
    return Object.values(balances).reduce((s, v) => s + (v || 0), 0);
  }, [balances]);

  const getButtonState = (p) => {
    const available = isProductAvailable(p);
    const hasInitData = !!initDataRef.current;
    if (!available) return { disabled: true, label: "Tạm hết hàng" };
    if (!hasInitData) return { disabled: true, label: "Mở từ bot để mua" };
    if (!webAppReady) return { disabled: true, label: "Đang tải Telegram..." };
    return { disabled: buyingId === p.id, label: buyingId === p.id ? "Đang gửi..." : "Mua ngay" };
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen text-[#6B7280]">
        Đang tải...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center text-red-600">
        <p className="font-semibold">Lỗi</p>
        <p className="text-sm mt-1">{error}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F5F5] p-4 pb-8">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-[#1a1a1a]">🛍 Cửa hàng</h1>
          {totalCredits !== null && (
            <div className="text-sm font-medium text-[#f97815]">
              💰 {totalCredits.toLocaleString()} cr
            </div>
          )}
        </div>

        {user ? (
          <div className="text-sm text-[#6B7280] mb-4">
            Xin chào, <b>{user.first_name || user.username || user.id}</b>
          </div>
        ) : (
          <div className="text-sm text-amber-600 bg-amber-50 p-3 rounded-xl mb-4">
            ⚠️ Chế độ xem thử. Mở từ bot Telegram để mua hàng.
          </div>
        )}

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm sản phẩm..."
          className="w-full px-4 py-3 rounded-xl border border-[#E5E7EB] bg-white text-[#1a1a1a] placeholder-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#f97815] mb-4"
        />

        {filtered.length === 0 ? (
          <div className="text-center text-[#6B7280] py-10">
            Không tìm thấy sản phẩm.
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((p) => {
              const { disabled, label } = getButtonState(p);
              return (
                <div
                  key={p.id}
                  className="bg-white rounded-2xl p-4 shadow-sm border border-[#E5E7EB]"
                >
                  <h2 className="font-bold text-[#1a1a1a]">{p.name}</h2>
                  {p.description && (
                    <p className="text-sm text-[#6B7280] mt-1 line-clamp-2">
                      {p.description}
                    </p>
                  )}
                  <div className="mt-3 flex items-center justify-between text-sm">
                    <span className="text-[#f97815] font-bold">
                      {p.priceCredits.toLocaleString()} credits
                    </span>
                    <span className="text-[#6B7280]">
                      {p.stock === null || p.stock === undefined
                        ? "Không giới hạn"
                        : `Còn ${p.stock}`}
                    </span>
                  </div>
                  <button
                    onClick={() => handleBuy(p.id)}
                    disabled={disabled}
                    className={`mt-3 w-full py-2.5 rounded-xl font-semibold text-white transition-colors ${
                      disabled
                        ? "bg-[#D1D5DB] cursor-not-allowed"
                        : "bg-[#f97815] hover:bg-[#e0650a]"
                    }`}
                  >
                    {label}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
