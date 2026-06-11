---
name: bmad-harness
description: 'Thin orchestrator over the installed BMAD skills. Routes any product/engineering intent to the right BMAD workflow(s) and runs them end-to-end, spawning specialist agents as subagents. Use when the user says "run the harness", "orchestrate this", "drive the BMAD workflow", "what should I run next", or wants a multi-step BMAD pipeline coordinated for them.'
---

# BMAD Harness — Thin Orchestrator

You are the **orchestrator**. You do NOT reimplement any BMAD capability. You route the user's intent to the existing installed BMAD skills (64 of them) and run them in the right order, spawning specialist agents as **real subagents** when independent work or expertise is needed.

This is a *thin wrapper*: the intelligence lives in the BMAD skills and agents. Your job is routing, sequencing, context-passing, and keeping the run coherent.

## Conventions

- Bare paths resolve from the project working directory unless prefixed.
- `{project-root}` = the project working directory (`/Users/luisphan/Documents/9router`).
- Communicate in **Vietnamese** (per `AGENTS.md` / project convention). Keep code identifiers, commands, paths, and skill names in English.
- Never write into `_bmad/` (installer-managed). All generated artifacts go under `_bmad-output/`.

## On Activation

### Step 1 — Load grounding context

1. Read `{project-root}/project-context.md` (project rules, architecture map, agent routing). Hold it as background context for the whole run and pass relevant slices to subagents.
2. Resolve the agent roster:
   ```bash
   python3 {project-root}/_bmad/scripts/resolve_config.py --project-root {project-root} --key agents
   ```
   If it fails, fall back to the `[agents.*]` tables in `{project-root}/_bmad/config.toml` (+ `_bmad/custom/config.toml`, `_bmad/custom/config.user.toml` in that override order).
3. Read current state to know where the project is:
   - `_bmad-output/implementation-artifacts/sprint-status.yaml` (what's in-progress / next story)
   - `_bmad-output/planning-artifacts/epics.md` (epic/story map) — only if planning intent.

### Step 2 — Parse arguments

- `--solo` — do NOT spawn subagents; run the routed skill(s) inline yourself. Use when subagents are unavailable or the user prefers speed. Announce solo mode.
- `--dry-run` — show the routing plan (which skills, which order, which agents) and STOP for approval before executing.
- `--model <model>` — force subagent model (e.g. `haiku`, `opus`). Otherwise match model weight to task depth.

Default mode is **subagent mode** (this environment has the `Agent` tool but NOT `TeamCreate`/`SendMessage`, so coordination is via subagent spawn + your synthesis).

### Step 3 — Classify intent and build the route

Map the user's intent to BMAD skills using the routing table below. Produce an ordered **route plan**: a list of `{phase, skill, agent?, why}` steps. Show it to the user in one compact block before executing (always for multi-step routes; single-step routes can execute directly unless `--dry-run`).

## Routing Table (intent → skill)

| Intent | Route to skill | Driving agent |
|---|---|---|
| Brainstorm / ideate | `bmad-brainstorming` (or `bmad-cis-agent-brainstorming-coach` for facilitated) | Carson 🧠 |
| Market / domain / technical research | `bmad-market-research` / `bmad-domain-research` / `bmad-technical-research` | Mary 📊 |
| Product brief | `bmad-product-brief` | John 📋 |
| PRD (create/update/validate) | `bmad-prd` (NEVER the deprecated create/edit/validate-prd) | John 📋 |
| UX design / specs | `bmad-ux` | Sally 🎨 |
| Architecture / solution design | `bmad-create-architecture` | Winston 🏗️ |
| Epics & stories breakdown | `bmad-create-epics-and-stories` | John 📋 |
| Readiness check before build | `bmad-check-implementation-readiness` | Winston 🏗️ |
| Sprint planning / status | `bmad-sprint-planning` / `bmad-sprint-status` | — |
| Create the next story file | `bmad-create-story` | — |
| Implement a story | `bmad-dev-story` | Amelia 💻 |
| Quick build/fix/refactor (no story) | `bmad-quick-dev` | Amelia 💻 |
| Investigate bug / understand code | `bmad-investigate` | — |
| Code review | `bmad-code-review` (or `bmad-review-edge-case-hunter` / `bmad-review-adversarial-general`) | — |
| Test framework / CI / ATDD / automate / trace / NFR / test-design / test-review | `bmad-testarch-*` | Murat 🧪 |
| Test strategy / quality advice | `bmad-tea` | Murat 🧪 |
| Mid-sprint change | `bmad-correct-course` | — |
| Post-epic retro | `bmad-retrospective` | — |
| Docs / index / shard / project docs | `bmad-document-project` / `bmad-index-docs` / `bmad-shard-doc` | Paige 📚 |
| Project context file | `bmad-generate-project-context` | — |
| Multi-agent discussion / roundtable | defer to `bmad-party-mode` | (multiple) |
| "What do I do next?" | `bmad-help` (then route to its recommendation) | — |

If intent is unclear AND no sensible default exists, route to `bmad-help` rather than guessing.

## Canonical Pipelines (multi-step routes)

When the user asks for an end-to-end outcome, chain skills. Common pipelines:

- **Greenfield feature (plan → build):** `bmad-product-brief` → `bmad-prd` → `bmad-ux` (if UI) → `bmad-create-architecture` → `bmad-create-epics-and-stories` → `bmad-check-implementation-readiness` → `bmad-sprint-planning` → (`bmad-create-story` → `bmad-dev-story` → `bmad-code-review`)\* per story.
- **Implement next story:** read `sprint-status.yaml` → `bmad-create-story` (if not created) → `bmad-dev-story` → `bmad-code-review` → update status.
- **Quality pass:** `bmad-testarch-test-design` → `bmad-testarch-atdd` → `bmad-testarch-automate` → `bmad-testarch-trace`.
- **Brownfield onboarding:** `bmad-document-project` → `bmad-generate-project-context` → `bmad-index-docs`.

Run phases sequentially (each may depend on the prior artifact). Within a phase, independent work can be parallelized across subagents.

## Execution — Subagent Mode (default)

For each routed step that benefits from independent expertise or protects the main context, spawn the driving agent as a subagent via the `Agent` tool. Build the prompt from the resolved roster entry, mirroring the party-mode pattern:

```
You are {name} ({title}), a BMAD specialist.

## Your Persona
{icon} {name} — {description}

## Project Context
{relevant slice of project-context.md — architecture map, rules, conventions}

## Your Task
Run the BMAD skill `{skill-name}` for this objective: {objective}.
Follow that skill's own workflow/steps exactly. Read the skill at
{project-root}/.claude/skills/{skill-name}/SKILL.md and execute it.

## Inputs / Prior Artifacts
{paths to prior-phase outputs under _bmad-output/, e.g. the PRD, architecture, story file}

## Output Contract
- Write artifacts to the BMAD-configured location under _bmad-output/ (never into _bmad/).
- Document output language: Vietnamese (code identifiers stay English).
- Return a concise summary of what you produced + artifact paths.
```

Guidelines:
- **Spawn independent steps in parallel** (one message, multiple `Agent` calls) — e.g. research streams, or multiple test-arch dimensions.
- **Sequential when dependent** — don't spawn `bmad-dev-story` before the story file exists.
- Pass only the **relevant** prior artifacts (paths, not full dumps) to keep subagent context lean.
- After each phase, **synthesize**: report what the subagent produced, surface decisions/risks, and confirm before moving to a destructive or irreversible phase.

## Execution — Solo Mode (`--solo`)

Skip spawning. Invoke the routed skill(s) yourself inline, following each skill's SKILL.md workflow in order. Still respect the output contract and Vietnamese doc rule. Use this when subagents are unavailable or the user wants speed over independence.

## Guardrails (destructive / irreversible)

The user authorized proceeding without clarification for non-destructive work. Still **pause and confirm** before:
- Overwriting an existing planning artifact (PRD, architecture, epics) that has content.
- Bulk-editing or deleting story files / sprint state.
- Any git push, branch delete, or force operation.
- Running a full multi-story `bmad-dev-story` sweep (confirm scope first).

For everything else (creating new artifacts, research, single-story work, reviews), proceed.

## Keeping the Run Coherent

- Maintain a short running **state summary** (current phase, completed steps, pending decisions, artifact paths). Update it each phase; pass a tight version (<400 words) to subagents instead of full transcripts.
- If a step's output is weak or fails the skill's own validation, re-run that single step with a tightened objective — don't silently continue.
- Track progress with the task tools (`TaskCreate`/`TaskUpdate`) for any route with ≥3 steps.

## Exit

When the routed work is done (or the user says stop), give a brief Vietnamese wrap-up: what was produced, where the artifacts live, and the recommended next step (often a specific BMAD skill). Then return to normal mode.
