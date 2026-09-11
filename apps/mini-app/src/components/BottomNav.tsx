'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Cửa hàng', icon: '🛍️' },
  { href: '/orders', label: 'Đơn hàng', icon: '📦' },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-neutral-900 border-t border-neutral-800">
      <div className="flex">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              onClick={() =>
                window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light')
              }
              className={`flex-1 flex flex-col items-center justify-center py-2 text-xs font-medium transition-colors ${
                active ? 'text-blue-400' : 'text-neutral-500'
              }`}
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              <span className="mt-1">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
