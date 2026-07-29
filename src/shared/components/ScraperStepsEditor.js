"use client";

import { useState } from "react";
import { cn } from "@/shared/utils/cn";

const MAX_STEPS = 10;

export default function ScraperStepsEditor({ value, onChange, errors }) {
  const steps = value?.steps || [];
  const collect = value?.collect || { timeoutMs: 30000, idleMs: 1500, maxMessages: 20 };

  const updateSteps = (next) => {
    onChange({ steps: next, collect });
  };

  const updateStep = (index, patch) => {
    const next = steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    updateSteps(next);
  };

  const addStep = () => {
    if (steps.length >= MAX_STEPS) return;
    updateSteps([
      ...steps,
      { action: "send", text: "", match: "exact", collect: false },
    ]);
  };

  const removeStep = (index) => {
    const next = steps.filter((_, i) => i !== index);
    updateSteps(next);
  };

  const moveStep = (index, direction) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(newIndex, 0, moved);
    updateSteps(next);
  };

  const updateCollect = (patch) => {
    onChange({ steps, collect: { ...collect, ...patch } });
  };

  const stepError = typeof errors === "string" ? errors : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {steps.map((step, index) => (
          <div
            key={index}
            className={cn(
              "p-3 rounded-[10px] border border-border-subtle bg-surface-2/50",
              step.collect && "ring-1 ring-brand-500/30"
            )}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium text-text-muted w-6">{index + 1}.</span>
              <select
                value={step.action}
                onChange={(e) => updateStep(index, { action: e.target.value })}
                className="text-sm bg-surface-2 rounded-[8px] border border-border-subtle px-2 py-1 text-text-main"
              >
                <option value="send">send</option>
                <option value="press">press</option>
              </select>
              <select
                value={step.match || "exact"}
                onChange={(e) => updateStep(index, { match: e.target.value })}
                className="text-sm bg-surface-2 rounded-[8px] border border-border-subtle px-2 py-1 text-text-main"
              >
                <option value="exact">exact</option>
                <option value="contains">contains</option>
              </select>
              <label className="flex items-center gap-1.5 text-xs text-text-main ml-auto">
                <input
                  type="checkbox"
                  checked={!!step.collect}
                  onChange={(e) => updateStep(index, { collect: e.target.checked })}
                  className="rounded border-border-subtle"
                />
                collect
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => moveStep(index, -1)}
                  disabled={index === 0}
                  className="p-1 rounded-[6px] text-text-muted hover:bg-surface-3 disabled:opacity-30"
                >
                  <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                </button>
                <button
                  type="button"
                  onClick={() => moveStep(index, 1)}
                  disabled={index === steps.length - 1}
                  className="p-1 rounded-[6px] text-text-muted hover:bg-surface-3 disabled:opacity-30"
                >
                  <span className="material-symbols-outlined text-[16px]">arrow_downward</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeStep(index)}
                  className="p-1 rounded-[6px] text-red-500 hover:bg-red-500/10"
                >
                  <span className="material-symbols-outlined text-[16px]">delete</span>
                </button>
              </div>
            </div>
            <input
              type="text"
              value={step.text || ""}
              onChange={(e) => updateStep(index, { text: e.target.value })}
              placeholder={step.action === "send" ? "Message text, e.g. /start" : "Button text"}
              className="w-full text-sm bg-surface-2 rounded-[8px] border border-border-subtle px-3 py-2 text-text-main placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
          </div>
        ))}
        {stepError && (
          <p className="text-xs text-red-500 flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px]">error</span>
            {stepError}
          </p>
        )}
        <button
          type="button"
          onClick={addStep}
          disabled={steps.length >= MAX_STEPS}
          className="text-sm text-text-muted hover:text-text-main flex items-center gap-1 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          Add step ({steps.length}/{MAX_STEPS})
        </button>
      </div>

      <div className="p-3 rounded-[10px] border border-border-subtle bg-surface-2/50 space-y-3">
        <p className="text-xs font-medium text-text-muted uppercase tracking-wider">Collect settings</p>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-text-main block mb-1">Timeout (ms)</label>
            <input
              type="number"
              value={collect.timeoutMs}
              onChange={(e) => updateCollect({ timeoutMs: Number(e.target.value) })}
              min={100}
              max={60000}
              className="w-full text-sm bg-surface-2 rounded-[8px] border border-border-subtle px-3 py-2 text-text-main"
            />
          </div>
          <div>
            <label className="text-xs text-text-main block mb-1">Idle (ms)</label>
            <input
              type="number"
              value={collect.idleMs}
              onChange={(e) => updateCollect({ idleMs: Number(e.target.value) })}
              min={10}
              max={10000}
              className="w-full text-sm bg-surface-2 rounded-[8px] border border-border-subtle px-3 py-2 text-text-main"
            />
          </div>
          <div>
            <label className="text-xs text-text-main block mb-1">Max messages</label>
            <input
              type="number"
              value={collect.maxMessages}
              onChange={(e) => updateCollect({ maxMessages: Number(e.target.value) })}
              min={1}
              max={50}
              className="w-full text-sm bg-surface-2 rounded-[8px] border border-border-subtle px-3 py-2 text-text-main"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
