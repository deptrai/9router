"use client";

import { useState } from "react";
import { Card, Button, Input } from "@/shared/components";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (res.ok) {
        setSent(true);
      } else {
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setError("notfound");
        } else {
          setError(data.error || "Đã xảy ra lỗi");
        }
      }
    } catch {
      setError("Đã xảy ra lỗi. Vui lòng thử lại.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4 relative overflow-hidden">
      <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-primary mb-2">9Router</h1>
          <p className="text-text-muted">Quên mật khẩu</p>
        </div>

        <Card>
          {sent ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="flex items-center justify-center w-16 h-16 rounded-full bg-green-500/10 text-green-500">
                <span className="material-symbols-outlined text-[32px]">mark_email_read</span>
              </div>
              <h2 className="text-lg font-semibold">Kiểm tra hộp thư</h2>
              <p className="text-sm text-text-muted text-center">
                Nếu email tồn tại trong hệ thống, chúng tôi đã gửi link đặt lại mật khẩu. Link có hiệu lực trong 1 giờ.
              </p>
              <a href="/login" className="text-primary hover:underline text-sm mt-2">
                ← Quay lại đăng nhập
              </a>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <p className="text-sm text-text-muted">
                Nhập email đã đăng ký. Chúng tôi sẽ gửi link đặt lại mật khẩu.
              </p>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Email</label>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              {error && error !== "notfound" && <p className="text-xs text-red-500">{error}</p>}
              {error === "notfound" && (
                <div className="text-xs text-center">
                  <p className="text-red-500 mb-1">Email không tồn tại trong hệ thống.</p>
                  <a href="/register" className="inline-block px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-medium hover:opacity-90 transition-opacity">
                    Đăng ký tài khoản mới
                  </a>
                </div>
              )}
              <Button type="submit" variant="primary" className="w-full" loading={loading}>
                Gửi link đặt lại
              </Button>
              <p className="text-xs text-center text-text-muted mt-2">
                <a href="/login" className="text-primary hover:underline">← Quay lại đăng nhập</a>
              </p>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
