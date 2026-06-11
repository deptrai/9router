// Migration 007: context-safe combo presets for Claude Code long sessions.
// Keep Kiro models first for cost/latency, then add cx/gpt-5.5 as large-context fallback.
import { syncContextSafeCombos } from "../seeds/contextSafeCombos.js";

const migration = {
  version: 7,
  name: "context-safe-combos",
  up(db) {
    syncContextSafeCombos(db);
  },
};

export default migration;
