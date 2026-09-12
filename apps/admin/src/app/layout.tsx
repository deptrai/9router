import './globals.css';
import type { Metadata } from 'next';
import { AdminNavbar } from '../components/AdminNavbar';
import { AdminKeyModal } from '../components/AdminKeyModal';
import { ToastProvider } from '../components/Toast';

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
      <body className="bg-slate-950 text-slate-100 min-h-screen antialiased">
        <ToastProvider>
          <AdminNavbar />
          <AdminKeyModal />
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
