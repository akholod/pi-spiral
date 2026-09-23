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
   review re-openings. The in-memory PRD is the truth while the loop runs.
   The prompt rule "never touch ralph state" is NOT a security boundary:
   the executor and cleaner have a shell and can reach any path. What the
   loop guarantees is **detection**, not prevention: run state lives
   outside the working tree (`~/.pi/agent/spiral/ralph/<project>/<runId>`),
   every persist first compares `prd.json` and `run.json` against the
   digests in `integrity.json` and fails the run on drift, and a resume
   refuses drifted state unless the user explicitly adopts it. Revision
   digests per criterion (OMC) would not add prevention either, so they
   are not ported.
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
   `ralph.verify` (config) is executed after every story, before the
   reviewer is asked, and after cleanup; the output is handed to the
   executor, reviewer and cleaner as fresh evidence. This keeps the
   reviewer read-only (no bash) while still gating on real test runs.
   Commands the PRD planner proposes come from a model, so they run only
   after the user confirms them (`/ralph` asks; the `ralph` tool never
   runs them). With no commands at all the run reports `verification:
   none` instead of pretending a pass.
4. **Completion invariants in code**: a story passes only with every
   active criterion reported met with substantive evidence (a boolean is
   not evidence) and a green verify run; a red verify run before the
   review re-opens the PRD with a regression story instead of asking the
   reviewer; APPROVE with an uncovered, unverified or evidence-less
   criterion or a CRITICAL/MAJOR finding is downgraded to REJECT; a
   rejection re-opens the named stories, and findings that name no story
   become a `RV-nnn` review story so the PRD remains the only completion
   authority.
5. **Cleanup is checked, not trusted**: after the cleaner (and any
   repair) the git delta must stay inside the run's changed-file set,
   otherwise the run fails; if a repair changed code after the approval,
   the reviewer must approve again before `completed`. A pure cleanup
   pass with a green verify run is accepted without a second review, as
   in OMC.
6. **Budgets**: `maxIterations` story attempts (review rounds have their
   own `maxReviewAttempts`, outcome `exhausted`, never force-accepted as
   OMC does after its max), three consecutive failed attempts of one
   story or an executor `blocked` report (outcome `blocked`), two
   regression-repair attempts after cleanup (outcome `failed` if still
   red).
7. **State and resume**: `run.json` carries the outcome and phase;
   `--resume [runId]` accepts only a UUID of this project, refuses
   completed runs, validates every field fail-closed. One active run per
   project (lock file with pid, stale locks reclaimed).
8. **The loop never commits**, and checks it: HEAD is recorded at start
   and a moved HEAD is reported in the summary.

## Consequences

- Deterministic, testable loop (`test/ralph.test.ts` drives it with a fake
  delegate) and honest outcomes; no polite-stop or PRD-theater failure
  modes because those decisions are not left to the model.
- Operators who want regression checks without a confirmation prompt set
  `ralph.verify` explicitly; the model-proposed list is advisory.
- Not ported on purpose: stale-PRD reconciliation with observable checks,
  criteria-revision digests, `/goal` conflict policies, company context,
  `--critic=codex` (a per-run `--reviewer <provider/model>` replaces it),
  story-level architect gate (one completion review over all stories).
  Default reviewer is the critic, not OMC's architect.
