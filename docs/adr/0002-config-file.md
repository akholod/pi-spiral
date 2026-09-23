# ADR 0002: Configuration in spiral.json (user + project, JSONC)

Status: accepted
Date: 2026-09-22

## Context

Every role needs a configurable model. Users must be able to change defaults
globally and per project. pi extensions in this environment already follow
a `~/.pi/agent/<name>.json` + `.pi/<name>.json` convention (pi-claude-bridge)
and OMC uses `omc.jsonc` with the same user/project layering.

## Decision

- Files: `~/.pi/agent/spiral.json`, `.pi/spiral.json`. Project overrides
  user key by key (deep merge). JSONC accepted.
- One `RoleConfig` shape for every role: `model` (fully qualified
  `provider/model` or `inherit`), `thinking`, `timeoutMs`.
- Defaults live in code (`DEFAULT_CONFIG`) and are always valid: Opus for
  planner/architect, GPT-5.6 Sol for critic, 5 iterations.
- Fail-closed: a parse error, unknown key, wrong shape or invalid value
  makes the loader return `DEFAULT_CONFIG` with `fallback: true` and the
  issue list. `/ralplan` refuses to start unless the user confirms running
  on defaults; the `ralplan` tool returns an error result. Limits:
  `ralplan.maxIterations` <= 5 (OMC reference), `timeoutMs` <= the
  pi-subagents cap, dirs relative without `..`.
- The project file is read only when `ctx.isProjectTrusted()`; the config
  dir name comes from pi's `CONFIG_DIR_NAME`.
- Invalid model ids are not checked here; they surface as child launch
  failures with the provider's message.
- `/spiral-config` prints the effective config and its sources.

## Alternatives

- `subagents.agentOverrides.spiral-planner.model` in pi settings. Works for
  runtime-registered agents and remains a valid override path, but keeps
  workflow settings (iterations, plans dir, deliberate mode) elsewhere.
  Spiral's explicit `model` per request wins over it.
- A `spiral` key inside `.pi/settings.json`. Rejected to avoid coupling to
  pi's settings schema.

## Consequences

Phase 2 (`ralph`) already has its config slot, so adding it is additive.
