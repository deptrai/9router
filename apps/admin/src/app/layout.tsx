import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '9Router Admin Portal',
  description: 'Management portal for 9Router E-Commerce Platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body className="bg-slate-950 text-slate-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}
