"use client";

import { useState, useEffect } from "react";
import { Card, Button } from "@/shared/components";

export default function ProfilePage() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unlinking, setUnlinking] = useState(null);
  const [telegramBotId, setTelegramBotId] = useState(null);

  useEffect(() => {
    fetch("/api/auth/social-providers")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setTelegramBotId(d.telegramBotId || null); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/users/me")
      .then(r => r.ok ? r.json() : Promise.reject("Failed to load"))
      .then(d => setUser(d))
      .catch(() => setError("Không thể tải thông tin tài khoản"))
      .finally(() => setLoading(false));
  }, []);

  const handleLinkGoogle = () => {
    window.location.href = "/api/auth/google/start?link=true";
  };

  const handleLinkTelegram = () => {
    if (!telegramBotId) return;
    // Set up popup callback before opening
    window.TelegramLoginWidget = {
      dataOnauth: async (user) => {
        delete window.TelegramLoginWidget;
        const res = await fetch("/api/auth/telegram/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...user, link: true }),
        });
        if (res.ok) {
          setUser(prev => ({ ...prev, telegramId: String(user.id) }));
        } else {
          const data = await res.json().catch(() => ({}));
          setError(data.error || "Telegram link failed");
        }
      },
    };
    window.open(
      `https://oauth.telegram.org/auth?bot_id=${telegramBotId}&origin=${window.location.origin}&request_access=write`,
      "_blank", "width=550,height=450"
    );
  };

  const handleUnlink = async (provider) => {
    setUnlinking(provider);
    try {
      const res = await fetch("/api/auth/unlink-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (res.ok) {
        setUser(prev => ({
          ...prev,
          googleSub: provider === "google" ? null : prev.googleSub,
          telegramId: provider === "telegram" ? null : prev.telegramId,
        }));
      } else {
        const data = await res.json();
        setError(data.error || "Unlink failed");
      }
    } catch {
      setError("An error occurred");
    } finally {
      setUnlinking(null);
    }
  };

  if (loading) {
    return <div className="p-6 text-text-muted">Loading...</div>;
  }
  if (error && !user) {
    return <div className="p-6 text-red-500">{error}</div>;
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Hồ sơ</h1>

      <Card className="mb-6">
        <div className="flex flex-col gap-3">
          <div className="flex justify-between">
            <span className="text-text-muted text-sm">Email</span>
            <span className="text-sm">{user?.email || "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-muted text-sm">Tên hiển thị</span>
            <span className="text-sm">{user?.displayName || "—"}</span>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold mb-4">Phương thức đăng nhập</h2>
        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between py-2 border-b border-border/40">
            <div>
              <span className="font-medium text-sm">Password</span>
              <span className="ml-2 text-xs text-text-muted">{user?.hasPassword ? "Đã thiết lập" : "Chưa có"}</span>
            </div>
          </div>

          <div className="flex items-center justify-between py-2 border-b border-border/40">
            <div>
              <span className="font-medium text-sm">Google</span>
              <span className="ml-2 text-xs text-text-muted">{user?.googleSub ? "Đã liên kết" : "Chưa liên kết"}</span>
            </div>
            {user?.googleSub ? (
              <Button type="button" variant="ghost" size="sm" loading={unlinking === "google"} onClick={() => handleUnlink("google")}>
                Hủy liên kết
              </Button>
            ) : (
              <Button type="button" variant="secondary" size="sm" onClick={handleLinkGoogle}>
                Liên kết
              </Button>
            )}
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <span className="font-medium text-sm">Telegram</span>
              <span className="ml-2 text-xs text-text-muted">{user?.telegramId ? "Đã liên kết" : "Chưa liên kết"}</span>
            </div>
            {user?.telegramId ? (
              <Button type="button" variant="ghost" size="sm" loading={unlinking === "telegram"} onClick={() => handleUnlink("telegram")}>
                Hủy liên kết
              </Button>
            ) : (
              <Button type="button" variant="secondary" size="sm" onClick={handleLinkTelegram}>
                Liên kết
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
