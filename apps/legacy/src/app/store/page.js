"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function PublicStorePage() {
  const router = useRouter();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authed, setAuthed] = useState(false);
  const [balance, setBalance] = useState(0);
  const [buyingProduct, setBuyingProduct] = useState(null);
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseResult, setPurchaseResult] = useState(null);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => {
        if (d.role === "user" || d.role === "admin") {
          setAuthed(true);
          fetch("/api/users/me/balance")
            .then((r) => r.json())
            .then((b) => setBalance(b.total ?? 0))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/store/products");
      const data = await res.json().catch(() => ({}));
      if (res.ok) setProducts(data.products || []);
      else setError(data.error || "Failed to load products");
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadProducts(); }, [loadProducts]);

  const handleBuyClick = (product) => {
    if (!authed) {
      router.push("/login?redirect=/store");
      return;
    }
    setBuyingProduct(product);
  };

  const confirmBuy = async () => {
    if (!buyingProduct) return;
    setPurchasing(true);
    setError("");
    try {
      const res = await fetch("/api/store/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: buyingProduct.id, quantity: 1 }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        router.push("/login?redirect=/store");
        return;
      }
      if (!res.ok) {
        setError(data.error || "Mua hàng thất bại.");
      } else {
        setPurchaseResult(data);
        setBuyingProduct(null);
        setBalance((prev) => prev - (buyingProduct.priceCredits || 0));
      }
    } catch {
      setError("Network error");
    }
    setPurchasing(false);
  };

  return (
    <div className="min-h-screen bg-[#0e0b09] text-white">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-[#181411]/90 backdrop-blur-md border-b border-[#3a2f27]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <button
            onClick={() => router.push("/landing")}
            className="flex items-center gap-3 cursor-pointer bg-transparent border-none p-0"
          >
            <div className="size-8 rounded bg-gradient-to-br from-[#f97815] to-orange-700 flex items-center justify-center text-white">
              <span className="material-symbols-outlined text-[20px]">hub</span>
            </div>
            <span className="text-white text-xl font-bold tracking-tight">9Router</span>
          </button>

          <div className="flex items-center gap-4">
            {authed ? (
              <>
                <div className="flex items-center gap-2 bg-[#1e1a17] border border-[#3a2f27] rounded-lg px-3 py-1.5">
                  <span className="material-symbols-outlined text-[16px] text-[#f97815]">toll</span>
                  <span className="text-sm font-medium text-white">{balance.toLocaleString()} credits</span>
                </div>
                <button
                  onClick={() => router.push("/dashboard")}
                  className="h-9 px-4 rounded-lg bg-[#f97815] hover:bg-[#e0650a] text-[#181411] text-sm font-bold transition-all"
                >
                  Dashboard
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => router.push("/login?redirect=/store")}
                  className="h-9 px-4 rounded-lg border border-[#3a2f27] text-gray-300 hover:text-white text-sm font-medium transition-colors"
                >
                  Đăng nhập
                </button>
                <button
                  onClick={() => router.push("/register")}
                  className="h-9 px-4 rounded-lg bg-[#f97815] hover:bg-[#e0650a] text-[#181411] text-sm font-bold transition-all"
                >
                  Đăng ký
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <div className="max-w-6xl mx-auto px-6 pt-16 pb-10 text-center">
        <h1 className="text-4xl md:text-5xl font-bold mb-4 bg-gradient-to-r from-[#f97815] to-orange-300 bg-clip-text text-transparent">
          Cửa hàng AI 9Router
        </h1>
        <p className="text-gray-400 text-lg max-w-xl mx-auto">
          Tài khoản, API key và dịch vụ AI được kiểm duyệt. Mua ngay, nhận tức thì.
        </p>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-20">
        {error && (
          <div className="mb-6 text-red-400 text-sm bg-red-500/10 border border-red-500/20 px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        {/* Purchase success */}
        {purchaseResult && (
          <div className="mb-8 bg-green-500/10 border border-green-500/20 rounded-xl p-6 space-y-4 max-w-lg mx-auto">
            <div className="flex items-center gap-3 text-green-400">
              <span className="material-symbols-outlined text-[24px]">check_circle</span>
              <span className="font-bold text-lg">{purchaseResult.message || "Mua hàng thành công!"}</span>
            </div>
            <div className="text-sm text-gray-400">
              Mã đơn: <code className="font-mono text-gray-300">{purchaseResult.order?.id}</code>
            </div>
            {purchaseResult.credentials && purchaseResult.credentials.length > 0 && (
              <div className="space-y-2">
                <span className="font-medium text-sm text-gray-200">Thông tin nhận được:</span>
                {purchaseResult.credentials.map((cred, idx) => (
                  <pre key={idx} className="bg-[#1e1a17] border border-[#3a2f27] p-3 rounded-lg font-mono text-xs text-green-300 overflow-x-auto whitespace-pre-wrap select-all">
                    {cred}
                  </pre>
                ))}
              </div>
            )}
            <button
              onClick={() => setPurchaseResult(null)}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Đóng
            </button>
          </div>
        )}

        {/* Products grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-52 rounded-xl bg-[#1e1a17] animate-pulse" />
            ))}
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-20 text-gray-500">Chưa có sản phẩm nào.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {products.map((p) => {
              const isOutOfStock = p.stock !== null && p.stock <= 0;
              const canAfford = authed && balance >= p.priceCredits;
              return (
                <div
                  key={p.id}
                  className="bg-[#181411] border border-[#3a2f27] rounded-xl p-5 flex flex-col justify-between hover:border-[#f97815]/40 hover:shadow-[0_0_20px_rgba(249,120,21,0.08)] transition-all"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-white text-base leading-tight">{p.name}</span>
                      <span className="px-2 py-0.5 rounded text-xs bg-[#2a2420] text-gray-400 whitespace-nowrap shrink-0">{p.kind}</span>
                    </div>
                    <p className="text-sm text-gray-400 line-clamp-2 min-h-[2.5rem]">
                      {p.description || "Không có mô tả."}
                    </p>
                    <div className="text-2xl font-bold text-[#f97815]">
                      {(p.priceCredits ?? 0).toLocaleString()}
                      <span className="text-sm font-normal text-gray-400 ml-1">credits</span>
                    </div>
                  </div>

                  <div className="mt-4 pt-4 border-t border-[#3a2f27] flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-500">
                      {p.stock !== null ? `Còn: ${p.stock}` : "Không giới hạn"}
                    </span>
                    {isOutOfStock ? (
                      <span className="px-3 py-1.5 text-xs text-red-400 bg-red-500/10 rounded-lg">Hết hàng</span>
                    ) : !authed ? (
                      <button
                        onClick={() => handleBuyClick(p)}
                        className="px-4 py-1.5 bg-[#f97815] hover:bg-[#e0650a] text-[#181411] rounded-lg text-sm font-bold transition-all"
                      >
                        Mua ngay
                      </button>
                    ) : !canAfford ? (
                      <button
                        onClick={() => router.push("/dashboard/credits")}
                        className="px-3 py-1.5 text-xs text-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/20 rounded-lg transition-colors"
                      >
                        Nạp credits
                      </button>
                    ) : (
                      <button
                        onClick={() => handleBuyClick(p)}
                        className="px-4 py-1.5 bg-[#f97815] hover:bg-[#e0650a] text-[#181411] rounded-lg text-sm font-bold transition-all"
                      >
                        Mua ngay
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Login prompt for guests */}
        {!authed && products.length > 0 && (
          <div className="mt-10 text-center space-y-3">
            <p className="text-gray-500 text-sm">Đăng nhập để mua hàng và quản lý đơn hàng của bạn.</p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => router.push("/login?redirect=/store")}
                className="h-9 px-5 rounded-lg border border-[#3a2f27] text-gray-300 hover:text-white text-sm font-medium transition-colors"
              >
                Đăng nhập
              </button>
              <button
                onClick={() => router.push("/register")}
                className="h-9 px-5 rounded-lg bg-[#f97815] hover:bg-[#e0650a] text-[#181411] text-sm font-bold transition-all"
              >
                Đăng ký miễn phí
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Confirm Buy Modal */}
      {buyingProduct && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-[#181411] border border-[#3a2f27] rounded-xl p-6 max-w-sm w-full space-y-4 shadow-2xl">
            <h3 className="text-lg font-bold text-white">Xác nhận mua</h3>
            <p className="text-sm text-gray-400">
              Mua <b className="text-white">{buyingProduct.name}</b> với giá{" "}
              <b className="text-[#f97815]">{buyingProduct.priceCredits?.toLocaleString()} credits</b>?
            </p>
            <div className="text-xs text-gray-500 space-y-1">
              <div>Số dư hiện tại: {balance.toLocaleString()} credits</div>
              <div>Số dư sau mua: {(balance - (buyingProduct.priceCredits || 0)).toLocaleString()} credits</div>
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => { setBuyingProduct(null); setError(""); }}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                disabled={purchasing}
              >
                Hủy
              </button>
              <button
                onClick={confirmBuy}
                className="px-4 py-2 bg-[#f97815] hover:bg-[#e0650a] text-[#181411] rounded-lg text-sm font-bold disabled:opacity-50 transition-all"
                disabled={purchasing}
              >
                {purchasing ? "Đang xử lý..." : "Xác nhận"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
