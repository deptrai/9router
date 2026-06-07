"use client";

import { useState } from "react";
import { Card, Button, Input } from "@/shared/components";
import { useRouter, useSearchParams } from "next/navigation";

export default function ResetPasswordPage() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState("form"); // "form" | "success" | "error"
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();
  const router = useRouter();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (newPassword.length < 8) {
      setError("Mật khẩu phải có ít nhất 8 ký tự");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Mật khẩu xác nhận không khớp");
      return;
    }

    const token = searchParams.get("token");
    if (!token) {
      setStatus("error");
      setError("Link đặt lại không hợp lệ");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });

      if (res.ok) {
        setStatus("success");
      } else {
        const data = await res.json();
        setStatus("error");
        setError(data.error || "Đặt lại mật khẩu thất bại");
      }
    } catch {
      setStatus("error");
      setError("Đã xảy ra lỗi");
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
          <p className="text-text-muted">Đặt lại mật khẩu</p>
        </div>

        <Card>
          {status === "success" && (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="flex items-center justify-center w-16 h-16 rounded-full bg-green-500/10 text-green-500">
                <span className="material-symbols-outlined text-[32px]">check_circle</span>
              </div>
              <h2 className="text-lg font-semibold text-green-500">Đặt lại thành công!</h2>
              <p className="text-sm text-text-muted text-center">Mật khẩu đã được cập nhật. Bạn có thể đăng nhập với mật khẩu mới.</p>
              <Button variant="primary" className="w-full mt-2" onClick={() => router.push("/login")}>
                Đăng nhập
              </Button>
            </div>
          )}

          {status === "error" && (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 text-red-500">
                <span className="material-symbols-outlined text-[32px]">error</span>
              </div>
              <h2 className="text-lg font-semibold text-red-500">Thất bại</h2>
              <p className="text-sm text-text-muted text-center">{error}</p>
              <a href="/forgot-password" className="text-primary hover:underline text-sm mt-2">
                Yêu cầu link mới →
              </a>
            </div>
          )}

          {status === "form" && (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <p className="text-sm text-text-muted">Nhập mật khẩu mới cho tài khoản của bạn.</p>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Mật khẩu mới</label>
                <Input
                  type="password"
                  placeholder="Ít nhất 8 ký tự"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Xác nhận mật khẩu</label>
                <Input
                  type="password"
                  placeholder="Nhập lại mật khẩu mới"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <Button type="submit" variant="primary" className="w-full" loading={loading}>
                Đặt lại mật khẩu
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
