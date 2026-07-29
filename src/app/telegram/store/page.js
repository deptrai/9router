"use client";

import { useEffect, useMemo, useState } from "react";

export default function TelegramStorePage() {
  const [products, setProducts] = useState([]);
  const [user, setUser] = useState(null);
  const [balances, setBalances] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [buyingId, setBuyingId] = useState(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.Telegram?.WebApp) return;

    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();

    const run = async () => {
      try {
        const res = await fetch("/api/telegram/validate-init-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: tg.initData }),
        });
        const init = await res.json();
        if (!res.ok || !init.ok) {
          throw new Error(init.error || "Xác thực Telegram thất bại");
        }
        setUser(init.user);

        const [productsRes, userInfoRes] = await Promise.all([
          fetch("/api/store/products"),
          init.user?.id
            ? fetch("/api/telegram/user-info", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ initData: tg.initData }),
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
        setLoading(false);
      }
    };

    run();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? products.filter((p) =>
          `${p.name} ${p.description || ""}`.toLowerCase().includes(q)
        )
      : products;
  }, [products, search]);

  const isBuyable = (p) => {
    if (!p.isActive) return false;
    if (p.stock !== null && p.stock !== undefined && p.stock <= 0) return false;
    return true;
  };

  const handleBuy = (productId) => {
    if (typeof window === "undefined" || !window.Telegram?.WebApp) return;
    setBuyingId(productId);
    window.Telegram.WebApp.sendData(
      JSON.stringify({ action: "buy", productId })
    );
  };

  const totalCredits = useMemo(() => {
    if (!balances) return null;
    return Object.values(balances).reduce((s, v) => s + (v || 0), 0);
  }, [balances]);

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

        {user && (
          <div className="text-sm text-[#6B7280] mb-4">
            Xin chào, <b>{user.first_name || user.username || user.id}</b>
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
              const buyable = isBuyable(p);
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
                    disabled={!buyable || buyingId === p.id}
                    className={`mt-3 w-full py-2.5 rounded-xl font-semibold text-white transition-colors ${
                      buyable
                        ? "bg-[#f97815] hover:bg-[#e0650a]"
                        : "bg-[#D1D5DB] cursor-not-allowed"
                    }`}
                  >
                    {buyable ? "Mua ngay" : "Tạm hết hàng"}
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
