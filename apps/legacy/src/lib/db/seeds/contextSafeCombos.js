export const CONTEXT_SAFE_COMBOS = [
  {
    name: "deep-search",
    models: ["cx/gpt-5.5"],
  },
  {
    name: "develop",
    models: ["kr/claude-sonnet-4.6", "cx/gpt-5.5"],
  },
  {
    name: "review",
    models: ["kr/claude-opus-4.8-thinking", "cx/gpt-5.5"],
  },
  {
    name: "dev-mini",
    models: ["kr/claude-haiku-4.5", "kr/auto-thinking", "kr/auto", "cx/gpt-5.5"],
  },
  {
    name: "haiku-4.5",
    models: ["kr/claude-haiku-4.5", "kr/auto-thinking", "kr/auto", "cx/gpt-5.4-mini", "cx/gpt-5.5"],
  },
  {
    name: "opus-4.8",
    models: [
      "kr/claude-opus-4.8-thinking-agentic",
      "kr/claude-opus-4.8-thinking",
      "kr/claude-opus-4.8-agentic",
      "kr/claude-opus-4.8",
      "cx/gpt-5.5",
    ],
  },
  {
    name: "sonnet-4.6",
    models: [
      "kr/claude-sonnet-4.6-thinking-agentic",
      "kr/claude-sonnet-4.6-thinking",
      "kr/claude-sonnet-4.6-agentic",
      "kr/claude-sonnet-4.6",
      "cx/gpt-5.5",
    ],
  },
];

export function syncContextSafeCombos(db) {
  const now = new Date().toISOString();
  for (const combo of CONTEXT_SAFE_COMBOS) {
    const models = JSON.stringify(combo.models);
    db.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt)
       VALUES(lower(hex(randomblob(16))), ?, NULL, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         models = excluded.models,
         updatedAt = CASE
           WHEN combos.models <> excluded.models THEN excluded.updatedAt
           ELSE combos.updatedAt
         END`,
      [combo.name, models, now, now]
    );
  }
}
