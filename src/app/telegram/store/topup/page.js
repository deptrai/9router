"use client";

import { useEffect, useRef, useState } from "react";

export default function TelegramStoreTopupPage() {
  const [user, setUser] = useState(null);
  const [balances, setBalances] = useState(null);
  const [method, setMethod] = useState("vnd");
  const [credits, setCredits] = useState("");
  const [amount, setAmount] = useState("");
  const [coin, setCoin] = useState("USDT");
  const [network, setNetwork] = useState("tron");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [payment, setPayment] = useState(null);
  const [pollStatus, setPollStatus] = useState(null);
  const [pollInterval, setPollInterval] = useState(null);
  const initDataRef = useRef("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const rawHash = window.location.hash ? window.location.hash.replace(/^#/, "") : "";
    const hashParams = new URLSearchParams(rawHash);
    const rawSearch = window.location.search ? window.location.search.replace(/^\?/, "") : "";
    const searchParams = new URLSearchParams(rawSearch);
    const tgInitData = typeof window !== "undefined" ? window.Telegram?.WebApp?.initData || window.__telegramInitData : "";
    const initData =
      tgInitData ||
      hashParams.get("tgWebAppData") ||
      searchParams.get("tgWebAppData") ||
      "";
    initDataRef.current = initData;

    const load = async () => {
      const current = initDataRef.current;
      if (!current) {
        setLoading(false);
        setError("Không tìm thấy initData. Mở lại từ Telegram.");
        return;
      }
      try {
        const res = await fetch("/api/telegram/user-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: current }),
        });
        const data = await res.json();
        if (data.ok) {
          setUser(data.user);
          setBalances(data.balances);
        } else {
          setError(data.error || "Không thể xác thực.");
        }
      } catch (e) {
        setError("Không thể tải thông tin user.");
      } finally {
        setLoading(false);
      }
    };

    const setupWebApp = () => {
      const tg = window.Telegram?.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
        if (tg.initData && !initDataRef.current) {
          initDataRef.current = tg.initData;
          load();
        }
      }
    };

    if (window.Telegram?.WebApp) {
      setupWebApp();
    } else {
      const script = document.createElement("script");
      script.src = "https://telegram.org/js/telegram-web-app.js";
      script.defer = true;
      script.onload = setupWebApp;
      document.head.appendChild(script);
    }

    load();
  }, []);

  useEffect(() => {
    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [pollInterval]);

  const totalCredits = () => {
    if (!balances) return 0;
    return Object.values(balances).reduce((s, v) => s + (v || 0), 0);
  };

  const startPolling = (paymentId) => {
    if (pollInterval) clearInterval(pollInterval);
    const initData = initDataRef.current;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/telegram/payment-status?initData=${encodeURIComponent(initData)}&id=${encodeURIComponent(paymentId)}`);
        const data = await res.json();
        if (data.ok) {
          setPollStatus(data.payment);
          if (data.payment.status === "settled" || data.payment.status === "confirmed") {
            clearInterval(id);
            setPollInterval(null);
            // Refresh balance
            const userRes = await fetch("/api/telegram/user-info", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ initData }),
            });
            const userData = await userRes.json();
            if (userData.ok) setBalances(userData.balances);
          } else if (["failed", "cancelled"].includes(data.payment.status)) {
            clearInterval(id);
            setPollInterval(null);
          }
        }
      } catch (e) {
        console.error("[telegram/topup] poll error:", e?.message);
      }
    }, 5000);
    setPollInterval(id);
  };

  const handleSubmit = async () => {
    const initData = initDataRef.current;
    if (!initData) {
      setError("Không tìm thấy initData.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setPayment(null);
    setPollStatus(null);

    try {
      const body = { initData, method };
      if (method === "vnd") {
        body.credits = Number(credits);
      } else {
        body.amount = Number(amount);
        body.coin = coin;
        body.network = network;
      }

      const res = await fetch("/api/telegram/miniapp-topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Tạo lệnh nạp thất bại.");
        return;
      }

      setPayment(data);
      startPolling(data.paymentId);
    } catch (e) {
      console.error("[telegram/topup] submit error:", e?.message);
      setError("Tạo lệnh nạp thất bại.");
    } finally {
      setSubmitting(false);
    }
  };

  const goBack = () => {
    if (typeof window === "undefined") return;
    window.location.href = "/telegram/store";
  };

  const closeApp = () => {
    const tg = window.Telegram?.WebApp;
    if (tg?.close) tg.close();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen text-[#6B7280]">Đang tải...</div>
    );
  }

  if (error && !payment) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center text-red-600">
        <p className="font-semibold">Lỗi</p>
        <p className="text-sm mt-1">{error}</p>
        <button onClick={goBack} className="mt-4 px-4 py-2 rounded-xl bg-[#f97815] text-white font-semibold">Quay lại cửa hàng</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F5F5] p-4 pb-8">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-[#1a1a1a]">💳 Nạp credits</h1>
          <div className="text-sm font-medium text-[#f97815]">💰 {totalCredits().toLocaleString()} cr</div>
        </div>

        {user && (
          <div className="text-sm text-[#6B7280] mb-4">
            Xin chào, <b>{user.first_name || user.username || user.id}</b>
          </div>
        )}

        {!payment && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#E5E7EB] space-y-4">
            <div>
              <label className="text-sm font-medium text-[#1a1a1a]">Phương thức</label>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => setMethod("vnd")}
                  className={`flex-1 py-2 rounded-xl font-medium text-sm ${method === "vnd" ? "bg-[#f97815] text-white" : "bg-[#F3F4F6] text-[#6B7280]"}`}
                >
                  VND
                </button>
                <button
                  onClick={() => setMethod("crypto")}
                  className={`flex-1 py-2 rounded-xl font-medium text-sm ${method === "crypto" ? "bg-[#f97815] text-white" : "bg-[#F3F4F6] text-[#6B7280]"}`}
                >
                  Crypto
                </button>
              </div>
            </div>

            {method === "vnd" ? (
              <div>
                <label className="text-sm font-medium text-[#1a1a1a]">Số credits</label>
                <input
                  type="number"
                  value={credits}
                  onChange={(e) => setCredits(e.target.value)}
                  placeholder="100"
                  className="w-full mt-2 px-4 py-3 rounded-xl border border-[#E5E7EB] bg-white text-[#1a1a1a] placeholder-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#f97815]"
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="text-sm font-medium text-[#1a1a1a]">Số USD</label>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="10"
                    className="w-full mt-2 px-4 py-3 rounded-xl border border-[#E5E7EB] bg-white text-[#1a1a1a] placeholder-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#f97815]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium text-[#1a1a1a]">Coin</label>
                    <select
                      value={coin}
                      onChange={(e) => setCoin(e.target.value)}
                      className="w-full mt-2 px-4 py-3 rounded-xl border border-[#E5E7EB] bg-white text-[#1a1a1a]"
                    >
                      <option value="USDT">USDT</option>
                      <option value="USDC">USDC</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-[#1a1a1a]">Network</label>
                    <select
                      value={network}
                      onChange={(e) => setNetwork(e.target.value)}
                      className="w-full mt-2 px-4 py-3 rounded-xl border border-[#E5E7EB] bg-white text-[#1a1a1a]"
                    >
                      <option value="tron">Tron</option>
                      <option value="polygon">Polygon</option>
                      <option value="ethereum">Ethereum</option>
                      <option value="solana">Solana</option>
                    </select>
                  </div>
                </div>
              </>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitting}
              className={`w-full py-3 rounded-xl font-semibold text-white transition-colors ${submitting ? "bg-[#D1D5DB] cursor-not-allowed" : "bg-[#f97815] hover:bg-[#e0650a]"}`}
            >
              {submitting ? "Đang tạo..." : "Tạo lệnh nạp"}
            </button>

            {error && <div className="text-sm text-red-600 bg-red-50 p-3 rounded-xl">{error}</div>}

            <button
              onClick={goBack}
              className="w-full py-2.5 rounded-xl font-semibold text-[#6B7280] bg-[#F3F4F6] hover:bg-[#E5E7EB]"
            >
              Quay lại cửa hàng
            </button>
          </div>
        )}

        {payment && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#E5E7EB] space-y-4">
            <h2 className="font-bold text-[#1a1a1a]">Thông tin thanh toán</h2>

            {payment.method === "vnd" ? (
              <>
                <p className="text-sm text-[#6B7280]">
                  Số tiền: <b>{payment.amountVnd.toLocaleString()}đ</b>
                </p>
                <p className="text-sm text-[#6B7280]">
                  Nội dung CK: <code className="bg-[#F3F4F6] px-2 py-1 rounded">{payment.memo}</code>
                </p>
                <p className="text-sm text-[#6B7280]">
                  STK: <code className="bg-[#F3F4F6] px-2 py-1 rounded">{payment.bankInfo?.accountNumber}</code>
                </p>
                {payment.qrUrl && (
                  <img
                    src={payment.qrUrl}
                    alt="QR Code"
                    className="w-full rounded-xl border border-[#E5E7EB]"
                  />
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-[#6B7280]">
                  Coin: <b>{payment.coin}</b> — Network: <b>{payment.network}</b>
                </p>
                <p className="text-sm text-[#6B7280]">
                  Số tiền: <b>${payment.amountExpected}</b>
                </p>
                <p className="text-sm text-[#6B7280] break-all">
                  Địa chỉ: <code className="bg-[#F3F4F6] px-2 py-1 rounded">{payment.payAddress}</code>
                </p>
              </>
            )}

            {pollStatus && (
              <div className="text-sm p-3 rounded-xl bg-[#F3F4F6]">
                Trạng thái: <b>{pollStatus.status}</b>
                {pollStatus.status === "settled" && (
                  <span> — đã cộng <b>{pollStatus.creditsAwarded || payment.credits || payment.amountExpected}</b> credits</span>
                )}
              </div>
            )}

            <button
              onClick={goBack}
              className="w-full py-2.5 rounded-xl font-semibold text-[#6B7280] bg-[#F3F4F6] hover:bg-[#E5E7EB]"
            >
              Quay lại cửa hàng
            </button>

            <button
              onClick={closeApp}
              className="w-full py-2.5 rounded-xl font-semibold text-white bg-[#f97815] hover:bg-[#e0650a]"
            >
              Đóng Mini App
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
