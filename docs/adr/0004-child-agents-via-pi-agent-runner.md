# ADR 0004: Run child agents in-process through pi-agent-runner

Status: accepted
Date: 2026-10-09
Supersedes: the delegation mechanism of ADR 0001 (the loop stays in code)

## Context

ADR 0001 ran every role as a pi-subagents child, launched through its
event protocol (`prompt-template:subagent:request`) after registering the
roles at `session_start`. That made pi-subagents a hard runtime
dependency, added a 30 s start timeout, request/node id correlation and a
registration step that failed silently in child processes. Its per-tool
timer also counted the time a person spent answering a permission dialog
and killed runs (incident 2026-10-08).

Phase 0 spikes (`docs/standalone-runner-plan.md`, "Spike results") showed
that a child can be a second `AgentSession` created with Pi's SDK in the
parent's process, from a command handler or a tool `execute`, with models
of extension providers (`claude-bridge`) and with permission prompts
forwarded to the parent's dialog.

## Decision

Spiral depends on `pi-agent-runner` (`~/pi_sandbox/pi-agent-runner`,
`git@github.com:akholod/pi-agent-runner.git`) and calls `runAgent` from
`src/subagents/delegation.ts`. pi-subagents is ignored even when installed.

- `delegate(parent, options)` keeps the `DelegationResponse` shape the
  loops are written against; `parent` is `{ events: pi.events, ctx }` of
  the command or tool that started the run.
- Roles are a table in code (`src/subagents/roles.ts`): the trimmed
  `agents/<role>.md` prompt replaces Pi's system prompt, no context files,
  no skills, no extensions except the model provider's. planner, architect
  and critic get `read, grep, find, ls`; executor and cleaner get Pi's
  default tools with the runner's git guard (no push, `reset --hard`,
  `clean -f`, `branch -D`, discarding checkout/restore).
- Structured results come only from the runner's `submit_result` tool;
  JSON is never parsed from prose.
- `permissionAsks` in `spiral.json` (`forward` default, `deny` for
  unattended runs) decides whether a child's permission `ask` reaches a
  person; the role timeout pauses while one is open.

## Consequences

- No install-time dependency on pi-subagents; no runtime registration.
- Children run in the parent process: a hung tool stops only on
  cooperative abort (Pi's `bash` has its own process and timeout).
- Operator settings `subagents.agentOverrides` / `defaultModel` no longer
  apply; role models come only from `spiral.json`.
- The runner is a separate package; Spiral pins it with `file:` until it
  is published.
