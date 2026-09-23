# pi-spiral

Pi extension that ports two workflows from
[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode):

- **ralplan** — consensus planning. A Planner drafts, an Architect and a
  Critic review the same snapshot independently, the Planner revises. Up to
  5 rounds, until the Critic approves. Output is a plan artifact marked
  `pending approval`. Nothing is executed.
- **ralph** — PRD-driven persistence loop that implements an approved plan
  story by story with reviewer sign-off. Phase 2, not implemented yet.

Status: **scaffold**. The loop, config, prompts and commands are in place;
the end-to-end run against pi-subagents has not been exercised yet. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the open
items.

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
  }
}
```

## Layout

```
extensions/spiral.ts        pi entry: commands, tool, agent registration
src/config.ts               config schema, loader, validation
src/subagents/              pi-subagents contracts (delegation, registration)
src/ralplan/                loop, prompts, verdict schema, artifact writer
src/ralph/                  phase 2 placeholder
agents/*.md                 role system prompts (planner, architect, critic)
docs/ARCHITECTURE.md        design and open questions
docs/adr/                   decisions
```
