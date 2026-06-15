"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import useAuthStore from "@/store/authStore";
import useSettingsStore from "@/store/settingsStore";
import Button from "./Button";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "tts", "stt"];
// Combined entry: webSearch + webFetch share one page at /dashboard/media-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: "travel_explore", href: "/dashboard/media-providers/web" };

// AC5: Admin-only nav items (hidden from role=user)
const adminNavItems = [
  { href: "/dashboard/endpoint", label: "Endpoint", icon: "api" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  // { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" }, // Hidden
  { href: "/dashboard/combos", label: "Combos", icon: "layers" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/mitm", label: "MITM", icon: "security" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
  { href: "/dashboard/users", label: "Users", icon: "group" },
  { href: "/dashboard/plans", label: "Plans", icon: "workspace_premium" },
  { href: "/dashboard/gift-codes", label: "Gift Codes", icon: "confirmation_number" },
];

// AC5: User-visible nav items (limited view for role=user)
const userNavItems = [
  { href: "/dashboard/endpoint", label: "Endpoint", icon: "api" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/credits", label: "Credits", icon: "paid" },
  { href: "/dashboard/plan", label: "Plan & Quota", icon: "verified" },
];

const debugItems = [
  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
];

const systemItems = [
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { href: "/dashboard/skills", label: "Skills", icon: "extension" },
];

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [mediaOpen, setMediaOpen] = useState(false);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const role = useAuthStore((s) => s.role);
  const fetchAuthStatus = useAuthStore((s) => s.fetchAuthStatus);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);
  useEffect(() => {
    fetchAuthStatus();
  }, [fetchAuthStatus]);

  useEffect(() => {
    fetchSettings().then((data) => {
      if (data?.enableTranslator) setEnableTranslator(true);
    });
  }, [fetchSettings]);

  const isActive = (href) => {
    if (href === "/dashboard/endpoint") {
      return pathname === "/dashboard" || pathname.startsWith("/dashboard/endpoint");
    }
    return pathname.startsWith(href);
  };


  return (
    <>
      <aside className="flex w-72 flex-col border-r border-border-subtle bg-vibrancy backdrop-blur-xl transition-colors duration-300 min-h-full">
        {/* Traffic lights */}
        <div className="flex items-center gap-2 px-6 pt-5 pb-2">
          <div className="w-3 h-3 rounded-full bg-[#FF5F56]" />
          <div className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
          <div className="w-3 h-3 rounded-full bg-[#27C93F]" />
        </div>

        {/* Logo */}
        <div className="px-6 py-4 flex flex-col gap-2">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="flex items-center justify-center size-9 rounded-[10px] bg-gradient-to-br from-brand-500 to-brand-700 shadow-[var(--shadow-warm)]">
              <span className="material-symbols-outlined text-white text-[20px]">hub</span>
            </div>
            <div className="flex flex-col">
              <h1 className="text-lg font-semibold tracking-tight text-text-main">
                {APP_CONFIG.name}
              </h1>
              <span className="text-xs text-text-muted">v{APP_CONFIG.version}</span>
            </div>
          </Link>

        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
          {/* AC5: While role is loading, show skeleton to avoid flash of admin nav */}
          {role === null ? (
            <div className="space-y-1 px-2 py-1">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-7 rounded-lg bg-surface-2 animate-pulse" />
              ))}
            </div>
          ) : (
            <>
              {/* AC5: role=user → userNavItems only; role=admin/legacy → adminNavItems */}
              {(role === "user" ? userNavItems : adminNavItems).map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                    isActive(item.href)
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[18px]",
                      isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                    )}
                  >
                    {item.icon}
                  </span>
                  <span className="text-[13px] font-medium">{item.label}</span>
                </Link>
              ))}

              {/* AC5: System section — admin/legacy only */}
              {role !== "user" && (
                <div className="pt-3 mt-2 space-y-0.5">
                  <p className="px-4 text-xs font-semibold text-text-muted/60 uppercase tracking-wider mb-2">
                    System
                  </p>

                  {/* Media Providers accordion */}
                  <button
                    onClick={() => setMediaOpen((v) => !v)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                      pathname.startsWith("/dashboard/media-providers")
                        ? "bg-primary/10 text-primary"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    )}
                  >
                    <span className="material-symbols-outlined text-[18px]">perm_media</span>
                    <span className="text-[13px] font-medium flex-1 text-left">Media Providers</span>
                    <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                      expand_more
                    </span>
                  </button>
                  {mediaOpen && (
                    <div className="pl-4">
                      {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                        <Link
                          key={kind.id}
                          href={`/dashboard/media-providers/${kind.id}`}
                          onClick={onClose}
                          className={cn(
                            "flex items-center gap-3 px-4 py-1 rounded-lg transition-all group",
                            pathname.startsWith(`/dashboard/media-providers/${kind.id}`)
                              ? "bg-primary/10 text-primary"
                              : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                          )}
                        >
                          <span className="material-symbols-outlined text-[16px]">{kind.icon}</span>
                          <span className="text-sm">{kind.label}</span>
                        </Link>
                      ))}
                      <Link
                        key={COMBINED_WEB_ITEM.id}
                        href={COMBINED_WEB_ITEM.href}
                        onClick={onClose}
                        className={cn(
                          "flex items-center gap-3 px-4 py-1 rounded-lg transition-all group",
                          pathname.startsWith(COMBINED_WEB_ITEM.href)
                            ? "bg-primary/10 text-primary"
                            : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                        )}
                      >
                        <span className="material-symbols-outlined text-[16px]">{COMBINED_WEB_ITEM.icon}</span>
                        <span className="text-sm">{COMBINED_WEB_ITEM.label}</span>
                      </Link>
                    </div>
                  )}

                  {systemItems.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onClose}
                      className={cn(
                        "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                        isActive(item.href)
                          ? "bg-primary/10 text-primary"
                          : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                      )}
                    >
                      <span
                        className={cn(
                          "material-symbols-outlined text-[18px]",
                          isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                        )}
                      >
                        {item.icon}
                      </span>
                      <span className="text-[13px] font-medium">{item.label}</span>
                    </Link>
                  ))}

                  {/* Debug items (inside System section, before Settings) */}
                  {debugItems.map((item) => {
                    const show = item.href !== "/dashboard/translator" || enableTranslator;
                    return show ? (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={onClose}
                        className={cn(
                          "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                          isActive(item.href)
                            ? "bg-primary/10 text-primary"
                            : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                        )}
                      >
                        <span
                          className={cn(
                            "material-symbols-outlined text-[18px]",
                            isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                          )}
                        >
                          {item.icon}
                        </span>
                        <span className="text-[13px] font-medium">{item.label}</span>
                      </Link>
                    ) : null;
                  })}

                  {/* Settings */}
                  <Link
                    href="/dashboard/profile"
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                      isActive("/dashboard/profile")
                        ? "bg-primary/10 text-primary"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    )}
                  >
                    <span
                      className={cn(
                        "material-symbols-outlined text-[18px]",
                        isActive("/dashboard/profile") ? "fill-1" : "group-hover:text-primary transition-colors"
                      )}
                    >
                      settings
                    </span>
                    <span className="text-[13px] font-medium">Settings</span>
                  </Link>
                </div>
              )}

              {/* AC5: user role — minimal System: only Settings (profile) */}
              {role === "user" && (
                <div className="pt-3 mt-2 space-y-0.5">
                  <p className="px-4 text-xs font-semibold text-text-muted/60 uppercase tracking-wider mb-2">
                    Account
                  </p>
                  <Link
                    href="/dashboard/profile"
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                      isActive("/dashboard/profile")
                        ? "bg-primary/10 text-primary"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    )}
                  >
                    <span
                      className={cn(
                        "material-symbols-outlined text-[18px]",
                        isActive("/dashboard/profile") ? "fill-1" : "group-hover:text-primary transition-colors"
                      )}
                    >
                      settings
                    </span>
                    <span className="text-[13px] font-medium">Settings</span>
                  </Link>
                </div>
              )}
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-border-subtle">
          <Button
            variant="ghost"
            fullWidth
            icon="logout"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/login";
            }}
            className="text-text-muted hover:text-text-main"
          >
            Logout
          </Button>
        </div>
      </aside>

    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};

