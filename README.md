# pi-spiral

Pi extension that ports two workflows from
[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode):

- **ralplan** — consensus planning. A Planner drafts, an Architect and a
  Critic review the same snapshot independently, the Planner revises. Up to
  5 rounds, until the Critic approves. Output is a plan artifact marked
  `pending approval`. Nothing is executed.
- **ralph** — PRD-driven persistence loop. A Planner drafts `prd.json`
  (user stories with testable acceptance criteria, optionally from a
  ralplan artifact), an Executor implements and verifies each story, an
  independent reviewer (Critic by default) verifies every criterion, then
  a bounded deslop pass cleans the changed files and the regression
  commands run again. Never commits.

Status: **implemented, not yet exercised live**. Both loops, config,
prompts, commands and tools are in place and unit-tested with a fake
delegate; an end-to-end run against pi-subagents has not been performed
yet. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- pi >= 0.87
- `pi-subagents` installed (`pi install npm:pi-subagents`). Spiral registers
  its role agents there and runs them through its delegation API.
- No extra providers by default: every role inherits the model selected in
  the pi session that runs `/ralplan`. The recommended profile below needs
  `pi-claude-bridge` (for `claude-bridge/claude-opus-5`) and the
  `openai-codex` provider (for `openai-codex/gpt-5.6-sol`).

## Install (development)

```bash
cd spiral
npm install
npm run typecheck
npm test
pi -e .            # try without installing
pi install .       # or install as a local package
```

## Usage

```
/ralplan add rate limiting to the public API
/ralplan --deliberate migrate sessions from redis to postgres
/ralplan --interactive --critic openai-codex/gpt-5.6-luna add caching
/spiral-config
```

Flags: `--deliberate` (force pre-mortem + expanded test plan),
`--interactive` (user checkpoints after the draft and after critic
approval), `--planner|--architect|--critic <provider/model>` (per-run role
model override, the pi equivalent of OMC's `--critic codex`).

The model can also call the `ralplan` tool itself when asked to plan
something non-trivial. The result is written to `.spiral/plans/<timestamp>-<slug>.md`.

### ralph

```
/ralph --plan .spiral/plans/2026-...-add-rate-limiting.md add rate limiting
/ralph fix the flaky retry test and the timeout it hides
/ralph --no-deslop --reviewer-agent architect implement the cache layer
/ralph --resume            # continue the latest run after a block/cancel
/ralph-cancel
```

Flow (OMC ralph steps 1-8): draft PRD → for each story with `passes:
false`: executor implements, reports per-criterion evidence, the loop
runs the verify commands and marks the story → when all pass: reviewer
verifies every criterion (APPROVE with gaps is downgraded, rejections
re-open stories) → cleaner runs the ai-slop-cleaner workflow on the
changed files → verify commands again (two repair attempts) → done.

Flags: `--no-deslop`, `--reviewer-agent critic|architect`, `--plan
<artifact>`, `--resume [runId]`, `--prd|--executor|--reviewer|--cleaner
<provider/model>`. Outcomes: `completed`, `exhausted` (iteration or review
budget), `blocked` (executor needs you, or one story failed three times),
`aborted`, `failed`. State lives in `.spiral/ralph/<runId>/` (`prd.json`,
`run.json`, `progress.md`).

A refuted acceptance criterion is never silently dropped: the executor
reports an amendment with evidence, the loop records it in the story's
ledger with the original text and re-verifies against the corrected
criteria.

The `ralph` tool exposes the same loop to the model. Verify commands come
from `ralph.verify` in the config, or from the PRD planner's proposal when
that list is empty.

## Configuration

`~/.pi/agent/spiral.json` (user) and `.pi/spiral.json` (project) are merged
key by key, project wins. JSONC is accepted. Full example with comments:
[spiral.config.example.jsonc](spiral.config.example.jsonc).

Built-in defaults set every role to `"inherit"`: children run on whatever
model the session has selected when the command starts, so a cheap chat
model means cheap planning. The critic then has no independent viewpoint,
which Spiral warns about once per session. Before any child is launched
the configured models are checked against pi's registry (known model,
credentials present) and the run refuses to start on a mismatch.
Recommended profile:

```json
{
  "ralplan": {
    "maxIterations": 5,
    "plansDir": ".spiral/plans",
    "deliberate": "auto",
    "roles": {
      "planner":   { "model": "claude-bridge/claude-opus-5", "thinking": "high" },
      "architect": { "model": "claude-bridge/claude-opus-5", "thinking": "high" },
      "critic":    { "model": "openai-codex/gpt-5.6-sol",    "thinking": "high" }
    }
  },
  "ralph": {
    "deslop": true,
    "reviewerAgent": "critic",
    "maxReviewAttempts": 3,
    "verify": ["npm test", "npm run typecheck"],
    "roles": {
      "prd":      { "model": "claude-bridge/claude-opus-5", "thinking": "high" },
      "executor": { "model": "claude-bridge/claude-opus-5", "thinking": "medium" },
      "reviewer": { "model": "openai-codex/gpt-6-sol",      "thinking": "high" },
      "cleaner":  { "model": "claude-bridge/claude-opus-5", "thinking": "medium" }
    }
  }
}
```

ralph keys: `maxIterations` (loop turns, default 20), `stateDir`,
`deslop`, `reviewerAgent`, `maxReviewAttempts`, `verify` (regression
commands run by the loop; empty means use the PRD planner's proposal),
`verifyTimeoutMs`, and the four roles `prd`, `executor`, `reviewer`,
`cleaner`. The executor and cleaner get pi's normal tools including a
shell; the other roles are read-only.

## Layout

```
extensions/spiral.ts        pi entry: commands, tool, agent registration
src/config.ts               config schema, loader, validation
src/subagents/              pi-subagents contracts (delegation, registration)
src/ralplan/                loop, prompts, verdict schema, artifact writer
src/ralph/                  prd model, loop, prompts, state, verify commands
agents/*.md                 role prompts (planner, architect, critic, executor, cleaner)
docs/ARCHITECTURE.md        design and open questions
docs/adr/                   decisions
```
