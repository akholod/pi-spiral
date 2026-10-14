# pi-spiral

Pi extension with two workflows ported from oh-my-claudecode:

- **ralplan** — consensus planning: planner drafts, architect and critic
  review independently, up to 5 rounds. Output is a plan artifact marked
  `pending approval`. Nothing is executed.
- **ralph** — PRD-driven execution: stories with testable acceptance
  criteria, an executor per story, regression commands run by the loop,
  independent reviewer, deslop pass. Never commits.

Child agents run in-process through
[pi-agent-runner](https://github.com/akholod/pi-agent-runner); no other
subagent package is needed.

## Install

```bash
pi install git:github.com/akholod/pi-spiral
```

## Usage

```
/ralplan <task>
/ralplan --deliberate --interactive <task>
/ralplan --preset deep <task>
/ralplan-cancel

/ralph <task>
/ralph --plan .spiral/plans/<artifact>.md <task>
/ralph --resume
/ralph --preset lite <task>
/ralph-cancel

/spiral-preset [name]
/spiral-config
```

Both loops are also available to the model as the `ralplan` and `ralph`
tools. `/agents` (from pi-agent-runner) lists running child agents: recent
activity, cancel, or take over.

## Configuration

`spiral.json` in the pi agent dir (`~/.pi/agent` or `PI_CODING_AGENT_DIR`,
user) and `.pi/spiral.json` (project), merged
key by key. By default every role inherits the session model. Recommended
profile and all keys: [spiral.config.example.jsonc](spiral.config.example.jsonc).

## Presets

Named overlays for the role settings (thinking, models, loop limits). Built-in,
no provider names, models stay as in your config:

- `lite`: no deliberate mode, 3 plan rounds, 2 review rounds, lower thinking.
- `deep`: deliberate mode always, `high`/`xhigh` thinking on every role.

Add your own under `presets` in `spiral.json` (allowed keys: `maxIterations`,
`deliberate`, `roles` for ralplan; `maxIterations`, `deslop`, `reviewerAgent`,
`maxReviewAttempts`, `budgetTokens`, `roles` for ralph). A project preset
replaces a user or built-in preset of the same name entirely; `default` is
reserved for "no preset".

Select with `--preset <name>` (or the `preset` tool parameter), per session
with `/spiral-preset [name]` (`default` clears it), or set `defaultPreset` in
`spiral.json`. Precedence: per-role model flags (`--critic`, `--executor`, ...,
advanced) > `--preset` > `/spiral-preset` > `defaultPreset` > base config.
`/ralph --resume` uses the currently effective preset and config, since run
state records only the task, deslop and reviewer agent, not role settings.

Design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/adr](docs/adr).
