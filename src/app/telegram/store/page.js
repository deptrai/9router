"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export default function TelegramStorePage() {
  const [products, setProducts] = useState([]);
  const [user, setUser] = useState(null);
  const [queryId, setQueryId] = useState(null);
  const [balances, setBalances] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [buyingId, setBuyingId] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [purchaseResult, setPurchaseResult] = useState(null);
  const [purchaseError, setPurchaseError] = useState(null);
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

  // Load SDK Telegram WebApp để có ready(), expand(), close().
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

  const loadUserAndProducts = async () => {
    const initData = initDataRef.current;
    try {
      let validated = null;
      if (initData) {
        const res = await fetch("/api/telegram/validate-init-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
        });
        validated = await res.json();
        if (res.ok && validated.ok) {
          setUser(validated.user);
        } else {
          console.error("[telegram/store] validate error:", validated.error);
        }
      }

      const [productsRes, userInfoRes] = await Promise.all([
        fetch("/api/store/products"),
        validated?.user?.id && initData
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
          setQueryId(userInfo.queryId || null);
        }
      }
    } catch (e) {
      console.error("[telegram/store] load error:", e?.message);
      setError(e?.message || "Không thể tải cửa hàng");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const run = async () => {
      await loadUserAndProducts();
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? products.filter((p) => `${p.name} ${p.description || ""}`.toLowerCase().includes(q))
      : products;
  }, [products, search]);

  const isProductAvailable = (p) => {
    if (!p.isActive) return false;
    if (p.stock !== null && p.stock !== undefined && p.stock <= 0) return false;
    return true;
  };

  const totalCredits = useMemo(() => {
    if (!balances) return 0;
    return Object.values(balances).reduce((s, v) => s + (v || 0), 0);
  }, [balances]);

  const handleBuyClick = (product) => {
    setSelectedProduct(product);
    setPurchaseResult(null);
    setPurchaseError(null);
    if (!initDataRef.current) {
      handleConfirmPurchase(product);
    }
  };

  const handleConfirmPurchase = async (product) => {
    const initData = initDataRef.current;
    if (!initData) {
      const tg = window.Telegram?.WebApp;
      if (tg?.sendData) {
        try {
          const requestId =
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random()}`;
          tg.sendData(JSON.stringify({ action: "buy", productId: product.id, quantity: 1, requestId }));
          setPurchaseResult({ message: "Đã gửi xác nhận qua bot Telegram." });
          return;
        } catch (e) {
          console.error("[telegram/store] sendData fallback error:", e?.message);
        }
      }
      setPurchaseError("Không có initData. Vui lòng mở lại từ Telegram.");
      return;
    }

    setBuyingId(product.id);
    setPurchaseError(null);
    setPurchaseResult(null);

    try {
      const requestId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      const res = await fetch("/api/telegram/miniapp-buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, productId: product.id, quantity: 1, requestId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setPurchaseError(data.error || "Mua hàng thất bại.");
        return;
      }

      if (data.success) {
        setPurchaseResult(data);
        // Refresh balance
        const userInfoRes = await fetch("/api/telegram/user-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
        });
        const userInfo = await userInfoRes.json();
        if (userInfo.ok) setBalances(userInfo.balances);

        // Optional: close after a short delay so user sees the success message.
        setTimeout(() => {
          const tg = window.Telegram?.WebApp;
          if (tg?.close) tg.close();
        }, 2500);
      } else {
        setPurchaseError(data.error || "Mua hàng thất bại.");
      }
    } catch (e) {
      console.error("[telegram/store] buy error:", e?.message);
      setPurchaseError("Mua hàng thất bại.");
    } finally {
      setBuyingId(null);
    }
  };

  const goToTopup = () => {
    if (typeof window === "undefined") return;
    window.location.href = "/telegram/store/topup";
  };

  const closeModal = () => {
    setSelectedProduct(null);
    setPurchaseResult(null);
    setPurchaseError(null);
  };

  const getButtonState = (p) => {
    const available = isProductAvailable(p);
    if (!available) return { disabled: true, label: "Tạm hết hàng" };
    if (!webAppReady) return { disabled: true, label: "Đang tải Telegram..." };
    return { disabled: buyingId === p.id, label: buyingId === p.id ? "Đang xử lý..." : "Mua ngay" };
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

  const productList = (
    <>
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Tìm sản phẩm..."
        className="w-full px-4 py-3 rounded-xl border border-[#E5E7EB] bg-white text-[#1a1a1a] placeholder-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#f97815] mb-4"
      />

      {filtered.length === 0 ? (
        <div className="text-center text-[#6B7280] py-10">Không tìm thấy sản phẩm.</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((p) => {
            const { disabled, label } = getButtonState(p);
            return (
              <div key={p.id} className="bg-white rounded-2xl p-4 shadow-sm border border-[#E5E7EB]">
                <h2 className="font-bold text-[#1a1a1a]">{p.name}</h2>
                {p.description && (
                  <p className="text-sm text-[#6B7280] mt-1 line-clamp-2">{p.description}</p>
                )}
                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-[#f97815] font-bold">{p.priceCredits.toLocaleString()} credits</span>
                  <span className="text-[#6B7280]">
                    {p.stock === null || p.stock === undefined ? "Không giới hạn" : `Còn ${p.stock}`}
                  </span>
                </div>
                <button
                  onClick={() => handleBuyClick(p)}
                  disabled={disabled}
                  className={`mt-3 w-full py-2.5 rounded-xl font-semibold text-white transition-colors ${
                    disabled ? "bg-[#D1D5DB] cursor-not-allowed" : "bg-[#f97815] hover:bg-[#e0650a]"
                  }`}
                >
                  {label}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  return (
    <div className="min-h-screen bg-[#F5F5F5] p-4 pb-8">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-[#1a1a1a]">🛍 Cửa hàng</h1>
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-[#f97815]">💰 {totalCredits.toLocaleString()} cr</div>
            <button
              onClick={goToTopup}
              className="text-sm px-2 py-1 rounded-lg bg-[#f97815] text-white font-medium hover:bg-[#e0650a]"
            >
              + Nạp
            </button>
          </div>
        </div>

        {user ? (
          <div className="text-sm text-[#6B7280] mb-4">
            Xin chào, <b>{user.first_name || user.username || user.id}</b>
          </div>
        ) : webAppReady ? (
          <div className="text-sm text-green-700 bg-green-50 p-3 rounded-xl mb-4">
            Sẵn sàng mua hàng. Bấm <b>Mua ngay</b> trên sản phẩm bạn chọn.
          </div>
        ) : (
          <div className="text-sm text-amber-600 bg-amber-50 p-3 rounded-xl mb-4">
            ⚠️ Mở từ bot Telegram để mua hàng.
          </div>
        )}

        {productList}

        {selectedProduct && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={closeModal}>
            <div
              className="bg-white rounded-2xl p-5 w-full max-w-md shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-bold text-[#1a1a1a] mb-1">Xác nhận mua</h2>
              <p className="text-sm text-[#6B7280] mb-4">
                {selectedProduct.name} — <span className="font-bold text-[#f97815]">{selectedProduct.priceCredits.toLocaleString()} credits</span>
              </p>

              <div className="flex items-center justify-between text-sm bg-[#F3F4F6] rounded-xl p-3 mb-4">
                <span className="text-[#6B7280]">Số dư hiện tại</span>
                <span className="font-semibold text-[#1a1a1a]">{totalCredits.toLocaleString()} cr</span>
              </div>

              {purchaseResult ? (
                <div className="text-center py-4">
                  <div className="text-4xl mb-2">🎉</div>
                  <p className="font-bold text-green-700">{purchaseResult.message}</p>
                  {purchaseResult.order?.id && (
                    <p className="text-sm text-[#6B7280] mt-1">Mã đơn: {purchaseResult.order.id}</p>
                  )}
                </div>
              ) : (
                <>
                  {purchaseError && (
                    <div className="text-sm text-red-600 bg-red-50 p-3 rounded-xl mb-4">{purchaseError}</div>
                  )}

                  {totalCredits < selectedProduct.priceCredits ? (
                    <div className="space-y-3">
                      <p className="text-sm text-red-600">Số dư không đủ để mua sản phẩm này.</p>
                      <button
                        onClick={goToTopup}
                        className="w-full py-3 rounded-xl font-semibold text-white bg-[#f97815] hover:bg-[#e0650a]"
                      >
                        Nạp credits
                      </button>
                      <button
                        onClick={closeModal}
                        className="w-full py-2.5 rounded-xl font-semibold text-[#6B7280] bg-[#F3F4F6] hover:bg-[#E5E7EB]"
                      >
                        Hủy
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <button
                        onClick={() => handleConfirmPurchase(selectedProduct)}
                        disabled={buyingId === selectedProduct.id}
                        className={`w-full py-3 rounded-xl font-semibold text-white transition-colors ${
                          buyingId === selectedProduct.id ? "bg-[#D1D5DB] cursor-not-allowed" : "bg-[#f97815] hover:bg-[#e0650a]"
                        }`}
                      >
                        {buyingId === selectedProduct.id ? "Đang xử lý..." : "Xác nhận mua"}
                      </button>
                      <button
                        onClick={closeModal}
                        className="w-full py-2.5 rounded-xl font-semibold text-[#6B7280] bg-[#F3F4F6] hover:bg-[#E5E7EB]"
                      >
                        Hủy
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
