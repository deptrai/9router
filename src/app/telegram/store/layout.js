export const metadata = {
  title: "9Router Store",
  description: "Telegram Mini App store",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function TelegramStoreLayout({ children }) {
  return (
    <html lang="vi">
      <head>
        <script src="https://telegram.org/js/telegram-web-app.js" defer />
      </head>
      <body className="bg-[#F5F5F5] text-[#1a1a1a] font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
