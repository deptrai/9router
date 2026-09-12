'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Package,
  Layers,
  Truck,
  ClipboardList,
  BarChart3,
  Lock,
  LayoutDashboard,
  ShieldCheck,
} from 'lucide-react';
import { getAdminApiKey, clearAdminApiKey } from '../lib/api-client';

export function AdminNavbar() {
  const pathname = usePathname();
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    const checkKey = () => setHasKey(Boolean(getAdminApiKey()));
    checkKey();

    window.addEventListener('admin_auth_updated', checkKey);
    window.addEventListener('admin_auth_required', checkKey);

    return () => {
      window.removeEventListener('admin_auth_updated', checkKey);
      window.removeEventListener('admin_auth_required', checkKey);
    };
  }, []);

  const navItems = [
    { href: '/', label: 'Tổng quan', icon: LayoutDashboard },
    { href: '/products', label: 'Sản phẩm', icon: Package },
    { href: '/suppliers', label: 'Nhà cung cấp', icon: Truck },
    { href: '/inventory', label: 'Kho nội bộ', icon: Layers },
    { href: '/orders', label: 'Đơn hàng', icon: ClipboardList },
    { href: '/finance', label: 'Đối soát', icon: BarChart3 },
  ];

  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-amber-500 to-amber-300 flex items-center justify-center text-slate-950 font-black text-base shadow-md shadow-amber-500/20">
                9R
              </div>
              <span className="font-bold text-base tracking-tight text-slate-100">
                Admin Console
              </span>
            </Link>

            <nav className="hidden md:flex items-center gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive =
                  item.href === '/'
                    ? pathname === '/'
                    : pathname.startsWith(item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      isActive
                        ? 'bg-slate-800 text-amber-400'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {hasKey ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Xác thực Admin</span>
                </span>
                <button
                  onClick={() => clearAdminApiKey()}
                  title="Đổi API Key / Khóa phiên"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  <Lock className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => window.dispatchEvent(new Event('admin_auth_required'))}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 text-slate-950 hover:bg-amber-400 transition-colors shadow-sm shadow-amber-500/20"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Nhập Key</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
