"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input } from "@/shared/components";
import { useRouter } from "next/navigation";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [telegramBotId, setTelegramBotId] = useState(null);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/social-providers")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setGoogleEnabled(!!d.googleEnabled); setTelegramBotId(d.telegramBotId || null); setTurnstileSiteKey(d.turnstileSiteKey || null); } })
      .catch(() => {});
  }, []);

  // Load Turnstile script + render widget once site key is known.
  useEffect(() => {
    if (!turnstileSiteKey) return;
    const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    let widgetId = null;

    const render = () => {
      const el = document.getElementById("turnstile-widget");
      if (!window.turnstile || !el || el.childElementCount > 0) return;
      widgetId = window.turnstile.render(el, {
        sitekey: turnstileSiteKey,
        callback: (token) => setTurnstileToken(token),
        "expired-callback": () => setTurnstileToken(""),
        "error-callback": () => setTurnstileToken(""),
      });
    };

    if (window.turnstile) {
      render();
    } else if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onload = render;
      document.head.appendChild(s);
    } else {
      const t = setInterval(() => { if (window.turnstile) { clearInterval(t); render(); } }, 200);
      return () => clearInterval(t);
    }

    return () => { try { if (widgetId && window.turnstile) window.turnstile.remove(widgetId); } catch { /* noop */ } };
  }, [turnstileSiteKey]);

  const handleRegister = async (e) => {
    e.preventDefault();
    setError("");

    // Client-side validation
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email address");
      return;
    }
    if (!password || password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setError("Please complete the captcha");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName: displayName || undefined, turnstileToken: turnstileToken || undefined }),
      });

      if (res.ok) {
        router.push("/dashboard");
        router.refresh();
      } else {
        const data = await res.json();
        setError(data.error || "Registration failed");
        // Reset captcha so user can retry
        if (turnstileSiteKey && window.turnstile) { try { window.turnstile.reset(); setTurnstileToken(""); } catch { /* noop */ } }
      }
    } catch {
      setError("An error occurred. Please try again.");
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
          <p className="text-text-muted">Create your account</p>
        </div>

        <Card>
          <form onSubmit={handleRegister} className="flex flex-col gap-4">
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

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Display Name (optional)</label>
              <Input
                type="text"
                placeholder="Your display name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Password</label>
              <Input
                type="password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Confirm Password</label>
              <Input
                type="password"
                placeholder="Confirm your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            {turnstileSiteKey && (
              <div id="turnstile-widget" className="flex justify-center" />
            )}

            <Button type="submit" variant="primary" className="w-full" loading={loading}>
              Create Account
            </Button>

            <p className="text-xs text-center text-text-muted mt-2">
              Already have an account?{" "}
              <a href="/login" className="text-primary hover:underline">
                Sign in
              </a>
            </p>

            {(googleEnabled || telegramBotId) && (
              <div className="flex flex-col gap-3 mt-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-border/60" />
                  <span className="text-xs text-text-muted px-2">hoặc</span>
                  <div className="flex-1 h-px bg-border/60" />
                </div>
                {googleEnabled && (
                  <Button type="button" variant="secondary" className="w-full" onClick={() => { window.location.href = "/api/auth/google/start"; }}>
                    Đăng ký bằng Google
                  </Button>
                )}
                {telegramBotId && (
                  <Button type="button" variant="secondary" className="w-full" onClick={() => { window.open(`https://oauth.telegram.org/auth?bot_id=${telegramBotId}&origin=${window.location.origin}&request_access=write`, "_blank", "width=550,height=450"); }}>
                    Đăng ký bằng Telegram
                  </Button>
                )}
              </div>
            )}
          </form>
        </Card>
      </div>
    </div>
  );
}
