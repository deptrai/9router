"use client";

import { useState, useEffect, useCallback } from "react";
import ConnectionUsageCard from "./ConnectionUsageCard";
import Card from "@/shared/components/Card";

export default function ConnectionUsage() {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchConnections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Lấy danh sách windsurf connections từ /api/providers (admin route).
      // Trang /dashboard/quota đã yêu cầu admin → route này доступ.
      const res = await fetch("/api/providers");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const windsurfConns = (data.connections || []).filter(
        (c) => c.provider === "windsurf",
      );
      setConnections(windsurfConns);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i} padding="md" className="h-48 animate-pulse bg-bg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card padding="md">
        <p className="text-sm text-red-500">
          Failed to load connections: {error}
        </p>
      </Card>
    );
  }

  if (connections.length === 0) {
    return (
      <Card padding="md">
        <div className="flex items-center gap-3 text-text-muted">
          <span className="material-symbols-outlined">cloud_off</span>
          <p className="text-sm">No Windsurf accounts connected.</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {connections.map((conn) => (
        <ConnectionUsageCard key={conn.id} connection={conn} />
      ))}
    </div>
  );
}
