"use client";

import { useState, useEffect } from "react";
import { Card, Button } from "@/shared/components";
import { useRouter, useSearchParams } from "next/navigation";

export default function VerifyEmailPage() {
  const [status, setStatus] = useState("loading"); // "loading" | "success" | "error"
  const [message, setMessage] = useState("");
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    async function verify() {
      const token = searchParams.get("token");

      if (!token) {
        setStatus("error");
        setMessage("Link xác minh không hợp lệ. Vui lòng kiểm tra lại email.");
        return;
      }

      try {
        const res = await fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
        if (res.ok) {
          setStatus("success");
          setMessage("Email của bạn đã được xác minh thành công!");
        } else {
          const data = await res.json().catch(() => ({}));
          setStatus("error");
          setMessage(data.error || "Link xác minh đã hết hạn hoặc không hợp lệ.");
        }
      } catch {
        setStatus("error");
        setMessage("Đã xảy ra lỗi. Vui lòng thử lại.");
      }
    }

    verify();
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4 relative overflow-hidden">
      <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-primary mb-2">9Router</h1>
          <p className="text-text-muted">Xác minh email</p>
        </div>

        <Card>
          <div className="flex flex-col items-center gap-4 py-4">
            {status === "loading" && (
              <>
                <div className="inline-block animate-spin rounded-full h-10 w-10 border-b-2 border-primary" />
                <p className="text-text-muted">Đang xác minh...</p>
              </>
            )}

            {status === "success" && (
              <>
                <div className="flex items-center justify-center w-16 h-16 rounded-full bg-green-500/10 text-green-500">
                  <span className="material-symbols-outlined text-[32px]">check_circle</span>
                </div>
                <h2 className="text-lg font-semibold text-green-500">Xác minh thành công!</h2>
                <p className="text-sm text-text-muted text-center">{message}</p>
                <Button
                  variant="primary"
                  className="w-full mt-2"
                  onClick={() => router.push("/dashboard")}
                >
                  Về Dashboard
                </Button>
              </>
            )}

            {status === "error" && (
              <>
                <div className="flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 text-red-500">
                  <span className="material-symbols-outlined text-[32px]">error</span>
                </div>
                <h2 className="text-lg font-semibold text-red-500">Xác minh thất bại</h2>
                <p className="text-sm text-text-muted text-center">{message}</p>
                <div className="flex flex-col gap-2 w-full mt-2">
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={() => router.push("/dashboard")}
                  >
                    Về Dashboard
                  </Button>
                  <Button
                    variant="ghost"
                    className="w-full"
                    onClick={() => router.push("/dashboard/profile")}
                  >
                    Gửi lại email xác minh
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
