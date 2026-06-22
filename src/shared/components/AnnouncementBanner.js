"use client";

import { useState, useEffect } from "react";

export default function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState([]);
  const [dismissed, setDismissed] = useState([]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("dismissed_announcements") || "[]");
      setDismissed(stored);
    } catch { setDismissed([]); }

    fetch("/api/announcements")
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.announcements) setAnnouncements(data.announcements); })
      .catch(() => {});
  }, []);

  const handleDismiss = (id) => {
    const updated = [...dismissed, id];
    setDismissed(updated);
    localStorage.setItem("dismissed_announcements", JSON.stringify(updated));
  };

  const visible = announcements.filter(a => !dismissed.includes(a.id));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-2 mb-4">
      {visible.map(a => (
        <div key={a.id} className="relative bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3">
          <button
            onClick={() => handleDismiss(a.id)}
            className="absolute top-2 right-3 text-blue-400 hover:text-blue-600 text-lg leading-none"
            aria-label="Dismiss"
          >
            &times;
          </button>
          <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">{a.title}</p>
          <p className="text-sm text-blue-700 dark:text-blue-300 mt-0.5">{a.body}</p>
        </div>
      ))}
    </div>
  );
}
