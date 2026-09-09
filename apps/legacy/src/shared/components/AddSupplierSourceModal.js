"use client";

import { useState } from "react";
import Modal from "./Modal";
import SupplierSourceForm from "./SupplierSourceForm";

export default function AddSupplierSourceModal({ isOpen, onClose, onCreated }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (payload) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/store/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to create supplier source");
      } else {
        onCreated?.(data.source);
        onClose();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add supplier source" size="xl">
      <SupplierSourceForm
        mode="create"
        onSubmit={handleSubmit}
        onCancel={onClose}
        loading={loading}
        serverError={error}
      />
    </Modal>
  );
}
