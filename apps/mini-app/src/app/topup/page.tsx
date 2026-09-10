'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { apiClient, getTelegramInitData } from '../../lib/api-client';
import type { PaymentTransactionDto } from '@repo/shared-types';

const PRESET_AMOUNTS = [
  { label: '50.000đ', value: 50000 },
  { label: '100.000đ', value: 100000 },
  { label: '200.000đ', value: 200000 },
  { label: '500.000đ', value: 500000 },
];

const MIN_TOPUP_AMOUNT = 10000;
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 100; // ~5 minutes

function formatVnd(value: number): string {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(value);
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'Hết hạn';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export default function TopupPage() {
  const [selectedAmount, setSelectedAmount] = useState<number | null>(null);
  const [customAmount, setCustomAmount] = useState<string>('');
  const [payment, setPayment] = useState<PaymentTransactionDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [balance, setBalance] = useState<number | null>(null);
  const [creditedAmount, setCreditedAmount] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const balanceRef = useRef<number | null>(null);
  const pollCountRef = useRef(0);

  useEffect(() => {
    window.Telegram?.WebApp?.ready();
  }, []);

  useEffect(() => {
    if (!payment?.expiresAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [payment?.expiresAt]);

  // Poll wallet balance while QR is active and not yet credited
  useEffect(() => {
    if (!payment || creditedAmount !== null) return;
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const checkBalance = async () => {
      try {
        const res = await apiClient.get<{ ok: boolean; wallet: { balance: string } }>(
          '/api/wallets/me'
        );
        if (cancelled) return;

        const previousBalance = balanceRef.current;
        const newBalance = Number(res.wallet.balance);

        // If this is the first successful poll, only set the baseline.
        if (previousBalance === null) {
          balanceRef.current = newBalance;
          setBalance(newBalance);
          return;
        }

        if (newBalance > previousBalance) {
          balanceRef.current = newBalance;
          setBalance(newBalance);

          if (newBalance - previousBalance === Number(payment.amount)) {
            setCreditedAmount(Number(payment.amount));
            window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
            if (interval) {
              clearInterval(interval);
              interval = null;
            }
            return;
          }
        }
      } catch {
        // Polling errors are ignored; we'll retry on the next tick.
      } finally {
        pollCountRef.current += 1;
      }
    };

    const tick = () => {
      if (cancelled) return;

      // Stop polling once the QR has expired.
      if (payment.expiresAt && new Date(payment.expiresAt).getTime() <= Date.now()) {
        if (interval) clearInterval(interval);
        setTimedOut(true);
        return;
      }

      if (pollCountRef.current >= MAX_POLLS) {
        if (interval) clearInterval(interval);
        setTimedOut(true);
        return;
      }

      checkBalance();
    };

    // First check immediately, then every POLL_INTERVAL_MS.
    checkBalance();
    interval = setInterval(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [payment, creditedAmount]);

  const finalAmount = useMemo(() => {
    if (selectedAmount !== null) return selectedAmount;
    const parsed = parseInt(customAmount.replace(/\D/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [selectedAmount, customAmount]);

  const validateAmount = (amount: number): string | null => {
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < MIN_TOPUP_AMOUNT) {
      return `Số tiền tối thiểu là ${formatVnd(MIN_TOPUP_AMOUNT)}`;
    }
    return null;
  };

  const handleCreateQr = async () => {
    setError(null);
    setPayment(null);
    setCreditedAmount(null);
    setTimedOut(false);
    balanceRef.current = null;
    pollCountRef.current = 0;

    const validationError = validateAmount(finalAmount);
    if (validationError) {
      setError(validationError);
      return;
    }

    const initData = getTelegramInitData();
    if (!initData) {
      setError('Vui lòng mở trong Telegram để xác thực.');
      return;
    }

    setLoading(true);
    try {
      const res = await apiClient.post<{ ok: boolean; payment: PaymentTransactionDto }>(
        '/api/payments/topup/vietqr',
        { amount: finalAmount }
      );
      setPayment(res.payment);
    } catch (err: any) {
      setError(err?.message || 'Không thể tạo mã QR. Vui lòng thử lại.');
    } finally {
      setLoading(false);
    }
  };

  const handleCheckAgain = () => {
    if (!payment) return;
    setTimedOut(false);
    setCreditedAmount(null);
    balanceRef.current = balance;
    pollCountRef.current = 0;
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  const countdown = payment?.expiresAt ? Math.max(0, new Date(payment.expiresAt).getTime() - now) : 0;

  return (
    <main className="p-4 flex flex-col items-center min-h-screen text-center">
      <h1 className="text-xl font-bold mb-4">Nạp tiền qua VietQR</h1>

      <div className="w-full max-w-sm rounded-xl bg-neutral-900 border border-neutral-800 p-4">
        <p className="text-sm text-neutral-400 mb-3">Chọn mệnh giá</p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {PRESET_AMOUNTS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => {
                setSelectedAmount(preset.value);
                setCustomAmount('');
              }}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                selectedAmount === preset.value
                  ? 'bg-emerald-600 border-emerald-500 text-white'
                  : 'bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-750'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <p className="text-sm text-neutral-400 mb-2">Hoặc nhập số tiền khác</p>
        <input
          type="text"
          inputMode="numeric"
          value={customAmount}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, '');
            setCustomAmount(raw ? parseInt(raw, 10).toLocaleString('vi-VN') : '');
            setSelectedAmount(null);
          }}
          placeholder="VD: 150.000"
          className="w-full rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
        />

        <button
          onClick={handleCreateQr}
          disabled={loading}
          className="w-full mt-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold py-2 text-sm transition"
        >
          {loading ? 'Đang tạo mã QR...' : 'Tạo mã QR'}
        </button>

        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}

        {creditedAmount !== null && (
          <div className="w-full max-w-sm rounded-xl bg-emerald-900 border border-emerald-600 p-3 mt-4 text-center">
            <p className="text-emerald-200 font-semibold">Đã nhận {formatVnd(creditedAmount)}</p>
          </div>
        )}

        {timedOut && creditedAmount === null && (
          <div className="w-full max-w-sm rounded-xl bg-amber-900 border border-amber-600 p-3 mt-4 text-center">
            <p className="text-amber-200 text-sm mb-2">Chưa nhận được tiền. Bạn có muốn kiểm tra lại?</p>
            <button
              onClick={handleCheckAgain}
              className="rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-sm font-medium px-3 py-1 transition"
            >
              Kiểm tra lại
            </button>
          </div>
        )}
      </div>

      {payment && creditedAmount === null && (
        <div className="w-full max-w-sm rounded-xl bg-neutral-900 border border-neutral-800 p-4 mt-4 text-left">
          <p className="text-sm text-neutral-400 mb-2">Quét mã QR để chuyển khoản</p>

          {payment.qrImageUrl && (
            <div className="flex justify-center mb-3">
              <img
                src={payment.qrImageUrl}
                alt="VietQR"
                className="rounded-lg max-w-full h-auto"
                style={{ maxHeight: 260 }}
              />
            </div>
          )}

          <div className="space-y-2 text-sm">
            <CopyableRow
              label="Ngân hàng"
              value={payment.bankName || ''}
              onCopy={() => handleCopy(payment.bankName || '', 'bankName')}
              copied={copied === 'bankName'}
            />
            <CopyableRow
              label="Số tài khoản"
              value={payment.bankAccount || ''}
              onCopy={() => handleCopy(payment.bankAccount || '', 'bankAccount')}
              copied={copied === 'bankAccount'}
            />
            <CopyableRow
              label="Nội dung CK"
              value={payment.transferContent}
              onCopy={() => handleCopy(payment.transferContent, 'transferContent')}
              copied={copied === 'transferContent'}
            />
            <CopyableRow
              label="Số tiền"
              value={formatVnd(Number(payment.amount))}
              onCopy={() => handleCopy(payment.amount, 'amount')}
              copied={copied === 'amount'}
            />
          </div>

          <p className="text-xs text-amber-400 mt-3">
            Mã QR hết hạn sau: <span className="font-mono font-semibold">{formatCountdown(countdown)}</span>
          </p>
        </div>
      )}
    </main>
  );
}

function CopyableRow({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-neutral-400 min-w-[100px]">{label}</span>
      <span className="text-neutral-100 font-medium truncate flex-1 text-right">{value}</span>
      <button
        onClick={onCopy}
        className="text-xs px-2 py-1 rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition"
      >
        {copied ? 'Đã chép' : 'Chép'}
      </button>
    </div>
  );
}
