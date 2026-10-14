# How Spiral works

Spiral ports `ralplan` and `ralph` from
[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) (OMC) to
pi. Role prompts in `agents/*.md` come from OMC's planner, architect, critic,
executor and cleaner, with Momus's "approve when a capable developer can
execute" bias folded into the critic.

## The loop is code, not a prompt

In OMC a skill _tells_ the main agent to run the loop. Models drift from such
instructions: they run reviews in parallel, skip a round, or show the critic
the architect's notes. Spiral runs the loop in TypeScript, so the order and
the information flow are guaranteed (ADR 0001, 0003).

Each role is a child pi session started through
[pi-agent-runner](https://github.com/akholod/pi-agent-runner)
(`src/subagents/delegation.ts`, ADR 0004). The role prompt replaces pi's
system prompt. Planner, architect, critic and reviewer get read-only tools
(`read, grep, find, ls`, no shell). Executor and cleaner get pi's normal
tools; git push, `reset --hard` and similar commands are blocked.

## ralplan

```text
for round in 1..maxIterations (≤ 5)
  planner   -> plan (text)
  architect -> review of that exact plan
  critic    -> structured verdict on the same plan, never sees the architect
  clean APPROVE ? stop : planner gets both reviews next round
write .spiral/plans/<ts>-<slug>.md   status: pending approval
```

- APPROVE counts only with no CRITICAL/MAJOR findings and all four gates
  passing; otherwise code downgrades it to ITERATE (`src/ralplan/loop.ts`).
- Deliberate mode (pre-mortem, wider test plan) turns on for risky tasks
  or `--deliberate`.
- Nothing in the project changes; the plan file is the only write.
- After 5 rounds without approval the latest plan is written and marked so.

## ralph

```text
prd role -> stories with acceptance criteria (prd.json)
for each open story
  executor implements it
  loop runs the verify commands, compares with the baseline
  every criterion met with evidence ? pass : retry (3 misses -> blocked)
all pass -> reviewer checks every criterion
  REJECT -> reopen stories, continue
  APPROVE -> cleaner tidies changed files -> verify again -> done
```

- Verify commands come from `ralph.verify`, or the PRD proposes them and
  you confirm.
- Failures that existed before the run are recorded once and don't block;
  only new ones do (`src/ralph/baseline.ts`).
- State lives outside the project in `<pi agent dir>/spiral/ralph/<project>/<runId>/`.
  The loop owns it and detects outside edits (`integrity.json`).
  `--resume` continues a stopped run.
- ralph never commits. A moved HEAD is reported.
- Limits: `maxIterations` story attempts, `maxReviewAttempts` review rounds,
  optional `budgetTokens`.

Different from OMC on purpose: one review over all stories instead of a gate
per story; a spent review budget ends as `exhausted` instead of a forced
accept.

## Config and presets

`<pi agent dir>/spiral.json` (user) and `.pi/spiral.json` (project, only in
trusted projects) merge key by key over built-in defaults (`src/config.ts`).
Any invalid value rejects the whole config: the commands ask before falling
back to defaults, the tools refuse to start. Every role defaults to `inherit`, so a fresh install works with
whatever model the session has.

A preset is a partial overlay of roles and loop limits. Same-named presets
replace each other whole: built-in, then user, then project. Precedence for a
run: per-role model flags > `--preset` > `/spiral-preset` > `defaultPreset` >
base config. Models are checked against pi's registry before the first child
starts (`src/ralplan/preflight.ts`).
