"use client";

import { useState } from "react";
import Modal from "./Modal";
import SupplierSourceForm from "./SupplierSourceForm";

export default function EditSupplierSourceModal({ isOpen, source, onClose, onSaved }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState(null);

  const handleSubmit = async (payload) => {
    setLoading(true);
    setError("");
    setTestResult(null);
    try {
      const res = await fetch(`/api/store/suppliers/${source.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to update supplier source");
      } else {
        onSaved?.(data.source);
        onClose();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  const handleTestSync = async () => {
    setLoading(true);
    setError("");
    setTestResult(null);
    try {
      const res = await fetch(`/api/store/suppliers/${source.id}?action=sync`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTestResult({ ok: false, message: data.error || "Sync failed" });
      } else {
        setTestResult({ ok: true, message: `Sync started — ${data.result || "ok"}` });
        onSaved?.(data.source);
      }
    } catch {
      setTestResult({ ok: false, message: "Network error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit supplier source" size="xl">
      {testResult && (
        <p className={`text-sm mb-4 ${testResult.ok ? "text-green-500" : "text-red-500"}`}>
          {testResult.message}
        </p>
      )}
      <SupplierSourceForm
        key={source.id}
        mode="edit"
        source={source}
        onSubmit={handleSubmit}
        onCancel={onClose}
        onTestSync={handleTestSync}
        loading={loading}
        serverError={error}
      />
    </Modal>
  );
}
