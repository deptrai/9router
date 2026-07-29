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
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){ try { const h = new URLSearchParams((window.location.hash||"").replace(/^#/,"")); const s = new URLSearchParams((window.location.search||"").replace(/^\\?/,"")); const raw = h.get("tgWebAppData") || s.get("tgWebAppData") || ""; if (raw) window.__telegramInitData = raw; } catch(e){} })();`,
        }}
      />
      {children}
    </>
  );
}
