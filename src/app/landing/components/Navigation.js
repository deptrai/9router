"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import useThemeStore from "@/store/themeStore";
import { reloadTranslations } from "@/i18n/runtime";

export default function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [locale, setLocale] = useState("en");
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { theme, toggleTheme } = useThemeStore();

  useEffect(() => {
    setMounted(true);
    const cookie = document.cookie.split(";").find((c) => c.trim().startsWith("locale="));
    if (cookie) setLocale(cookie.split("=")[1]?.trim() || "en");
  }, []);

  async function handleLocaleToggle() {
    const next = locale === "vi" ? "en" : "vi";
    try {
      await fetch("/api/locale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: next }) });
      await reloadTranslations();
      setLocale(next);
    } catch {}
  }

  const isDark = mounted && theme === "dark";

  return (
    <nav className="fixed top-0 z-50 w-full bg-[#181411]/80 backdrop-blur-md border-b border-[#3a2f27]">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <button
          type="button"
          className="flex items-center gap-3 cursor-pointer bg-transparent border-none p-0"
          onClick={() => router.push("/")}
          aria-label="Navigate to home"
        >
          <div className="size-8 rounded bg-linear-to-br from-[#f97815] to-orange-700 flex items-center justify-center text-white">
            <span className="material-symbols-outlined text-[20px]">hub</span>
          </div>
          <h2 className="text-white text-xl font-bold tracking-tight">9Router</h2>
        </button>

        {/* Desktop menu */}
        <div className="hidden md:flex items-center gap-8">
          <a className="text-gray-300 hover:text-white text-sm font-medium transition-colors" href="#features">Features</a>
          <a className="text-gray-300 hover:text-white text-sm font-medium transition-colors" href="#how-it-works">How it Works</a>
          <a className="text-gray-300 hover:text-white text-sm font-medium transition-colors" href="/models">Models</a>
          <a className="text-gray-300 hover:text-white text-sm font-medium transition-colors" href="/store">Store</a>
        </div>

        {/* Controls + CTA */}
        <div className="flex items-center gap-3">
          {/* Locale toggle */}
          <button
            onClick={handleLocaleToggle}
            aria-label="Toggle language"
            className="hidden sm:flex items-center text-xs font-medium text-gray-400 hover:text-white transition-colors border border-[#3a2f27] rounded px-2 py-1"
          >
            {locale === "vi" ? "EN" : "VI"}
          </button>

          {/* Dark/light toggle */}
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="hidden sm:flex items-center justify-center size-8 text-gray-400 hover:text-white transition-colors"
          >
            {isDark ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path d="M12 2.25a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM7.5 12a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM18.894 6.166a.75.75 0 00-1.06-1.06l-1.591 1.59a.75.75 0 101.06 1.061l1.591-1.59zM21.75 12a.75.75 0 01-.75.75h-2.25a.75.75 0 010-1.5H21a.75.75 0 01.75.75zM17.834 18.894a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 10-1.061 1.06l1.59 1.591zM12 18a.75.75 0 01.75.75V21a.75.75 0 01-1.5 0v-2.25A.75.75 0 0112 18zM7.758 17.303a.75.75 0 00-1.061-1.06l-1.591 1.59a.75.75 0 001.06 1.061l1.592-1.59zM6 12a.75.75 0 01-.75.75H3a.75.75 0 010-1.5h2.25A.75.75 0 016 12zM6.697 7.757a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 00-1.061 1.06l1.59 1.592z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="size-4">
                <path fillRule="evenodd" d="M9.528 1.718a.75.75 0 01.162.819A8.97 8.97 0 009 6a9 9 0 009 9 8.97 8.97 0 003.463-.69.75.75 0 01.981.98 10.503 10.503 0 01-9.694 6.46c-5.799 0-10.5-4.701-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 01.818.162z" clipRule="evenodd" />
              </svg>
            )}
          </button>

          <button
            onClick={() => router.push("/dashboard")}
            className="hidden sm:flex h-9 items-center justify-center rounded-lg px-4 bg-[#f97815] hover:bg-[#e0650a] transition-all text-[#181411] text-sm font-bold shadow-[0_0_15px_rgba(249,120,21,0.4)] hover:shadow-[0_0_20px_rgba(249,120,21,0.6)]"
          >
            Get Started
          </button>
          <button
            className="md:hidden text-white"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            <span className="material-symbols-outlined">{mobileMenuOpen ? "close" : "menu"}</span>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-[#3a2f27] bg-[#181411]/95 backdrop-blur-md">
          <div className="flex flex-col gap-4 p-6">
            <a className="text-gray-300 hover:text-white text-sm font-medium" href="#features" onClick={() => setMobileMenuOpen(false)}>Features</a>
            <a className="text-gray-300 hover:text-white text-sm font-medium" href="#how-it-works" onClick={() => setMobileMenuOpen(false)}>How it Works</a>
            <a className="text-gray-300 hover:text-white text-sm font-medium" href="/models" onClick={() => setMobileMenuOpen(false)}>Models</a>
            <a className="text-gray-300 hover:text-white text-sm font-medium" href="/store" onClick={() => setMobileMenuOpen(false)}>Store</a>
            <div className="flex gap-3">
              <button onClick={handleLocaleToggle} className="text-xs text-gray-400 border border-[#3a2f27] rounded px-2 py-1">{locale === "vi" ? "EN" : "VI"}</button>
              <button onClick={toggleTheme} className="text-gray-400">{isDark ? "☀️" : "🌙"}</button>
            </div>
            <button onClick={() => router.push("/dashboard")} className="h-9 rounded-lg bg-[#f97815] hover:bg-[#e0650a] text-[#181411] text-sm font-bold">Get Started</button>
          </div>
        </div>
      )}
    </nav>
  );
}
