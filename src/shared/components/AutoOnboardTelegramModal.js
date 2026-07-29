"use client";

import { useState } from "react";
import Modal from "./Modal";
import Button from "./Button";
import Input from "./Input";

const STEP = {
  FORM: 1,
  OTP: 2,
  RESULT: 3,
};

export default function AutoOnboardTelegramModal({ isOpen, onClose, onCreated }) {
  const [step, setStep] = useState(STEP.FORM);
  const [botUsername, setBotUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [vndPerCredit, setVndPerCredit] = useState("1");
  const [markupPct, setMarkupPct] = useState("10");
  const [loginId, setLoginId] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setStep(STEP.FORM);
    setBotUsername("");
    setPhone("");
    setVndPerCredit("1");
    setMarkupPct("10");
    setLoginId("");
    setPhoneCode("");
    setResult(null);
    setError("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleStart = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/store/suppliers/onboard/telegram/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không thể gửi mã OTP");
      setLoginId(data.loginId);
      setStep(STEP.OTP);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/store/suppliers/onboard/telegram/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loginId,
          phoneCode,
          botUsername,
          vndPerCredit: Number(vndPerCredit),
          markupPct: Number(markupPct),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không thể hoàn tất onboard");
      setResult(data);
      setStep(STEP.RESULT);
      onCreated?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Auto-onboard Telegram bot" size="md">
      <form onSubmit={step === STEP.FORM ? handleStart : handleVerify} className="space-y-5">
        {step === STEP.FORM && (
          <>
            <Input
              id="botUsername"
              label="Bot username"
              placeholder="tongmmobot"
              value={botUsername}
              onChange={(e) => setBotUsername(e.target.value.replace(/^@+/, ""))}
              required
              autoComplete="off"
            />
            <Input
              id="phone"
              label="Số điện thoại Telegram"
              placeholder="+84918668140"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              autoComplete="off"
              inputMode="tel"
            />
            <div className="grid grid-cols-2 gap-4">
              <Input
                id="vndPerCredit"
                label="Tỷ giá VND/credit"
                type="number"
                min="1"
                placeholder="1"
                value={vndPerCredit}
                onChange={(e) => setVndPerCredit(e.target.value)}
                required
                hint="VD: 1 nếu giá nút là VND"
              />
              <Input
                id="markupPct"
                label="Markup mặc định (%)"
                type="number"
                min="1"
                placeholder="10"
                value={markupPct}
                onChange={(e) => setMarkupPct(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={handleClose} disabled={loading}>
                Huỷ
              </Button>
              <Button type="submit" loading={loading}>
                Gửi mã OTP
              </Button>
            </div>
          </>
        )}

        {step === STEP.OTP && (
          <>
            <p className="text-sm text-text-muted">
              Telegram đã gửi mã OTP đến <strong className="text-text-main">{phone}</strong>. Nhập mã vào đây.
            </p>
            <Input
              id="phoneCode"
              label="Mã OTP"
              placeholder="12345"
              value={phoneCode}
              onChange={(e) => setPhoneCode(e.target.value)}
              required
              autoComplete="off"
              inputMode="numeric"
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setStep(STEP.FORM)} disabled={loading}>
                Quay lại
              </Button>
              <Button type="submit" loading={loading}>
                Xác minh & onboard
              </Button>
            </div>
          </>
        )}

        {step === STEP.RESULT && result && (
          <>
            <div className="space-y-2 text-sm text-text-muted">
              <p>Onboard <strong className="text-text-main">{botUsername}</strong> thành công.</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Products discovered: <strong>{result.productsDiscovered}</strong></li>
                <li>Products synced: <strong>{result.productsSynced}</strong></li>
                <li>Published: <strong>{result.published}</strong></li>
              </ul>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleClose}>Đóng</Button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
