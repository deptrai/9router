"use client";

import { useState, useEffect } from "react";
import { Card, Button } from "@/shared/components";

function StatusBadge({ announcement }) {
  const now = new Date();
  if (!announcement.isActive) return <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">Disabled</span>;
  if (announcement.endsAt && new Date(announcement.endsAt) < now) return <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">Expired</span>;
  if (announcement.startsAt && new Date(announcement.startsAt) > now) return <span className="px-2 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">Scheduled</span>;
  return <span className="px-2 py-0.5 rounded text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Active</span>;
}

function CreateModal({ onClose, onSuccess }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) { setError("Title and body are required"); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), startsAt: startsAt || null, endsAt: endsAt || null }),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error || "Failed"); }
      else { onSuccess(); onClose(); }
    } catch { setError("Network error"); }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-bg-main border border-border-subtle rounded-xl shadow-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold text-text-main mb-4">New Announcement</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-text-main">Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main" autoFocus />
          </label>
          <label className="block text-sm font-medium text-text-main">Body
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="mt-1 w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium text-text-main">Starts At
              <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main text-sm" />
            </label>
            <label className="block text-sm font-medium text-text-main">Ends At
              <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-1 text-text-main text-sm" />
            </label>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={loading} icon="campaign">Create</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AnnouncementsPage() {
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/announcements");
      if (res.ok) { const d = await res.json(); setAnnouncements(d.announcements || []); }
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const toggleActive = async (id, isActive) => {
    await fetch(`/api/admin/announcements/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !isActive }),
    });
    load();
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this announcement?")) return;
    await fetch(`/api/admin/announcements/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-main">Announcements</h1>
        <Button icon="add" onClick={() => setShowCreate(true)}>New</Button>
      </div>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">{[1, 2].map(i => <div key={i} className="h-12 bg-surface-2 animate-pulse rounded" />)}</div>
        ) : announcements.length === 0 ? (
          <div className="p-6 text-center text-text-muted text-sm">No announcements yet.</div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {announcements.map(a => (
              <div key={a.id} className="px-4 py-3 flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusBadge announcement={a} />
                    <span className="text-sm font-medium text-text-main truncate">{a.title}</span>
                  </div>
                  <p className="text-xs text-text-muted line-clamp-2">{a.body}</p>
                  <p className="text-xs text-text-muted mt-1">
                    {a.startsAt ? `From: ${new Date(a.startsAt).toLocaleString()}` : "Starts: immediately"}
                    {a.endsAt ? ` • Until: ${new Date(a.endsAt).toLocaleString()}` : " • No expiry"}
                  </p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <Button size="sm" variant="secondary" onClick={() => toggleActive(a.id, a.isActive)}>
                    {a.isActive ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleDelete(a.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onSuccess={load} />}
    </div>
  );
}
