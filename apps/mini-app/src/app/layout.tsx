import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '9Router Telegram Store',
  description: 'Telegram Mini App E-Commerce',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}
