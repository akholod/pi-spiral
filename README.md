# pi-spiral

Pi extension with two workflows ported from oh-my-claudecode:

- **ralplan** — consensus planning: planner drafts, architect and critic
  review independently, up to 5 rounds. Output is a plan artifact marked
  `pending approval`. Nothing is executed.
- **ralph** — PRD-driven execution: stories with testable acceptance
  criteria, an executor per story, regression commands run by the loop,
  independent reviewer, deslop pass. Never commits.

Requires `pi-subagents`.

## Install

```bash
pi install git:github.com/akholod/pi-spiral
```

## Usage

```
/ralplan <task>
/ralplan --deliberate --interactive <task>
/ralplan-cancel

/ralph <task>
/ralph --plan .spiral/plans/<artifact>.md <task>
/ralph --resume
/ralph-cancel

/spiral-config
```

Both loops are also available to the model as the `ralplan` and `ralph`
tools.

## Configuration

`~/.pi/agent/spiral.json` (user) and `.pi/spiral.json` (project), merged
key by key. By default every role inherits the session model. Recommended
profile and all keys: [spiral.config.example.jsonc](spiral.config.example.jsonc).

Design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/adr](docs/adr).
