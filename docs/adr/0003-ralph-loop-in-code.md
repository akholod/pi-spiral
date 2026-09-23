# ADR 0003: ralph as a code loop with a loop-owned PRD

- Status: accepted
- Date: 2026-09-23
- Reference: `oh-my-claudecode/skills/ralph/SKILL.md`,
  `src/hooks/ralph/{prd,loop,verifier,progress}.ts`,
  `skills/ai-slop-cleaner/SKILL.md`, ADR 03664 (criterion amendments)

## Context

In OMC, ralph is a prompt loop: the main Claude session is the
orchestrator, hooks re-inject the skill on every turn, and the model itself
edits `prd.json`, marks stories, spawns the reviewer and runs the cleaner
skill. A large part of OMC's ralph code (criteria-revision digests, CAS
writes, stale-PRD reconciliation, approval tags with request ids) exists
to defend the PRD against a model that has write access to it.

Spiral already runs ralplan as a TypeScript loop over pi-subagents
children (ADR 0001). The same shape fits ralph better than a prompt loop.

## Decision

1. **The loop is code** (`src/ralph/loop.ts`) and **owns prd.json**.
   Children only report; the loop applies `passes`, notes, amendments and
   review re-openings. No digests or CAS are needed because no child can
   touch the file. Children are told never to read or edit ralph state.
2. **Roles** (all registered at runtime with pi-subagents):
   - `prd`: the existing read-only planner agent drafts the PRD as
     structured JSON (stories, criteria, `verify` commands). Generic
     criteria are rejected in code and the draft is sent back once.
   - `executor`: a writer with pi's normal builtin tools (OMC executor
     prompt). Returns a structured report: status, per-criterion evidence,
     files changed, amendments, learnings, patterns, blockers.
   - `reviewer`: `spiral-critic` (default) or `spiral-architect`, both
     read-only, with a verification task built from OMC's verifier prompt
     plus the codex-critic directives (all criteria, related code,
     optimality, changed files). Returns a structured verdict.
   - `cleaner`: a writer running the ai-slop-cleaner workflow in standard
     mode, scoped to the run's changed files (OMC step 7.5).
3. **Verification commands run in the loop**, not in the reviewer.
   `ralph.verify` (config) or the PRD's `verify` list is executed after
   every story and after cleanup; the output is handed to the executor,
   reviewer and cleaner as fresh evidence. This keeps the reviewer
   read-only (no bash) while still gating on real test runs.
4. **Completion invariants in code**: a story passes only with every
   active criterion reported met and a green verify run; APPROVE with an
   uncovered or unverified criterion or a CRITICAL/MAJOR finding is
   downgraded to REJECT; a rejection re-opens the named stories, and
   findings that name no story become a `RV-nnn` review story so the PRD
   remains the only completion authority.
5. **Budgets**: `maxIterations` loop turns, `maxReviewAttempts` reviewer
   rounds (outcome `exhausted`, never force-accepted as OMC does after its
   max), three consecutive failed attempts of one story or an executor
   `blocked` report (outcome `blocked`), two regression-repair attempts
   after cleanup (outcome `failed` if still red).
6. **State** in `.spiral/ralph/<runId>/{prd.json, run.json, progress.md}`;
   `--resume [runId]` continues from disk without re-drafting.
7. **The loop never commits.**

## Consequences

- Deterministic, testable loop (`test/ralph.test.ts` drives it with a fake
  delegate) and honest outcomes; no polite-stop or PRD-theater failure
  modes because those decisions are not left to the model.
- Verify commands come from config or from the PRD planner's output. The
  planner is read-only but its proposed commands are executed by the loop;
  since the executor has a shell anyway, this adds no new capability, but
  operators who want full control set `ralph.verify` explicitly.
- Not ported on purpose: stale-PRD reconciliation with observable checks,
  criteria-revision digests, `/goal` conflict policies, company context,
  `--critic=codex` (a per-run `--reviewer <provider/model>` replaces it).
