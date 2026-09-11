import './globals.css';
import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import BottomNav from '../components/BottomNav';

export const metadata: Metadata = {
  title: '9Router Telegram Store',
  description: 'Telegram Mini App E-Commerce',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <head>
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
      </head>
      <body className="bg-neutral-950 text-neutral-100 min-h-screen antialiased touch-manipulation">
        {children}
        <BottomNav />
      </body>
    </html>
  );
}
