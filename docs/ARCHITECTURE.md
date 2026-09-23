# Spiral architecture

## Goal

Bring oh-my-claudecode's `ralplan` (consensus planning) and later `ralph`
(persistent execution) to pi as one installable package, with every role's
model configurable.

## Sources studied

| Source | What was taken |
|--------|----------------|
| `oh-my-claudecode/skills/ralplan/SKILL.md` | The loop contract: Planner → Architect → Critic, independent sequential reviews of one fixed snapshot, Planner-only synthesis, max 5 iterations, `pending approval` boundary, short vs deliberate mode, RALPLAN-DR structure, ADR in the final plan. |
| `oh-my-claudecode/agents/{planner,architect,critic}.md`, `skills/plan/SKILL.md` | Role prompts ported in full to `agents/*.md` (critic: pre-commitment, assumptions, pre-mortem, dependency/ambiguity/feasibility/rollback audits, executor/stakeholder/skeptic perspectives, gap analysis, self-audit, realist check, adversarial escalation, four ralplan gates; architect: consensus addendum; planner: plan output format incl. changelog on revision). Critic verdict is structured JSON mirroring OMC's Output_Format (`CRITIC_REVIEW_SCHEMA`). |
| `oh-my-claudecode/skills/ralph/SKILL.md` | PRD/story model reserved for phase 2 (`src/ralph`). |
| `oh-my-openagent` Prometheus / Momus / Metis | Momus's "approval bias" (approve when a capable developer can execute; MINOR never blocks) is folded into the critic prompt. Metis (pre-planning intent classification) is folded into the planner's step 1. A separate Metis pass is a possible phase 3. |
| pi-subagents docs | Runtime agent registration event, structured delegation API with per-request `model` and `thinking`, structured output schemas. |

## Key decision: the loop is code, not prompt

OMC implements ralplan as a skill: the main agent is *told* to run the loop
and spawn Task calls in the right order. That works in Claude Code but is
fragile (the model may parallelize the reviews, skip a round, or leak the
Architect review to the Critic).

Spiral runs the loop in TypeScript (`src/ralplan/loop.ts`). The invariants
are enforced by code:

1. Planner produces a plan snapshot (plain Markdown text).
2. Architect reviews that exact string. Critic reviews that exact string,
   after the Architect finishes, without receiving the Architect output.
3. Only the Planner receives both reviews, in the next round.
4. Stop at a clean Critic `APPROVE` (no CRITICAL/MAJOR findings, all four
   ralplan gates pass; otherwise downgraded to ITERATE in code) or after
   `maxIterations`.
5. No project mutation; the only write is the artifact.

See ADR 0001 for the alternatives considered.

## Runtime flow

```
/ralplan <task>  or  tool ralplan({task})
   │
   ▼
loadConfig(cwd)  ~/.pi/agent/spiral.json  <-  .pi/spiral.json
   │
   ▼
detectPlanMode(task)  short | deliberate
   │
   ▼
for i in 1..maxIterations
   ├─ delegate(spiral-planner,   model=roles.planner)   -> plan (text)
   ├─ delegate(spiral-architect, model=roles.architect) -> review (text)
   ├─ delegate(spiral-critic,    model=roles.critic)    -> CriticReview (structured JSON)
   └─ APPROVE ? break : continue with both reviews fed to the planner
   │
   ▼
write .spiral/plans/<ts>-<slug>.md  (frontmatter: status: pending approval)
   │
   ▼
pi.sendMessage summary (no turn trigger)  /  tool result
```

Each `delegate` call is one foreground pi-subagents child, launched through
the `prompt-template:subagent:request` event with the role's model and
thinking level from config. Role agents are registered at `session_start`
via `pi-subagents:runtime-agent-register:v1` with read-only tools
(`read, grep, find, ls`; no shell, since tool restrictions are the only
boundary and are not an OS sandbox).

## Config

Two files, JSONC, deep-merged with project precedence. One `RoleConfig`
shape (`model`, `thinking`, `timeoutMs`) is reused by every role in both
workflows so phase 2 needs no migration. Defaults: `inherit` (session
model) for every role so the package runs on any pi install; the example
config carries the recommended Opus / GPT-5.6 Sol profile. Preflight
(`src/ralplan/preflight.ts`) checks explicit models against
`ctx.modelRegistry` before the first child and warns once per session when
the critic shares the planner's model.

## Artifact

`.spiral/plans/<timestamp>-<slug>.md` with YAML frontmatter (`status`,
`mode`, `iterations`) followed by the final plan and a collapsible review
history per iteration. When the loop exhausts 5 rounds the best (latest)
version is written and the status says so.

## Open items before the first real run

1. **Delegation from a command handler.** pi-subagents says delegation
   "requires an active extension context. Emit requests from a supported
   event callback". A slash-command handler and a tool `execute` should
   qualify; verify with a one-round dry run and fall back to the
   workflow-resource route (ADR 0001, option B) if not.
2. **Identity.** `ownerRunId` is a UUID per ralplan run, node ids are
   unique per (iteration, role, feedback round); responses are correlated
   on the full tuple.
3. **Structured output for the critic on GPT-Sol.** Confirm the codex
   provider path supports `structured_output` in pi-subagents.
4. **`--interactive`.** Implemented for `/ralplan` (draft checkpoint:
   proceed / request changes / skip review; final checkpoint: approve /
   request changes / reject, OMC steps 2 and 6). The `ralplan` tool has no
   dialogs and ignores the flag. UI not yet exercised live.
5. **Missing pi-subagents at delegation time.** Detected by a 30 s timeout
   waiting for the `started` event (`src/subagents/delegation.ts`). Session
   start already warns when agent registration fails.
6. **Progress UX.** `ctx.ui.notify` per role is noisy; consider a widget
   via `ctx.ui.setWidget`.
7. **Cost.** Usage from every child (`DelegationResponse.usage`) is
   aggregated into the summary and the artifact frontmatter; no budget
   cap yet.
8. **Per-run role models.** `--planner|--architect|--critic <model>` on the
   command, `models` on the tool.

## Phase 2: ralph (outline)

Input: an approved artifact. Derive `prd.json` (stories with acceptance
criteria) with the planner model; loop executor child → verify → mark story;
reviewer child at the end; state in `.spiral/ralph/`. The executor is the
only writing role and runs with the `worker`-like tool set.

## Phase 3 ideas

- Metis-style pre-planning interview (`--interactive`).
- `/ralplan --architect codex` style per-run role overrides.
- Auto-gate: intercept vague "ralph ..." prompts and redirect to ralplan
  (OMC's pre-execution gate) via `pi.on('input', ...)`.
