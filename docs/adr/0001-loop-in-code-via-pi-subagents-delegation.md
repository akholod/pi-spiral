# ADR 0001: Run the ralplan loop in extension code via pi-subagents delegation

Status: accepted (scaffold), to be confirmed by the first end-to-end run
Date: 2026-09-22

## Context

OMC's ralplan is a prompt-driven workflow: a skill instructs the main agent
to spawn Planner, Architect and Critic tasks in a strict order. Pi offers
several ways to reproduce this.

## Options

**A. Extension-owned loop, children via pi-subagents structured delegation
API** (`prompt-template:subagent:request`). TypeScript controls ordering,
snapshot isolation, iteration cap and artifact writing. Per-request `model`
and `thinking` map directly to the config. Critic returns schema-validated
JSON.

**B. pi-subagents trusted workflow resource.** Register `spiral.ralplan`
whose `resolve()` returns a workflow script (`runs.run(...)` chain). Gets
fleet visibility and async for free. Scripts have no filesystem, so the
artifact must be written by a child or after the workflow returns; model per
run must be expressed in the script.

**C. Prompt/skill only** (OMC style). Ship a `/ralplan` prompt template
telling the main agent to call `subagent` in sequence. Zero code, but no
guarantee the invariants hold.

**D. Direct model calls** via `ctx.modelRegistry.streamSimple`. No
dependency on pi-subagents, but the roles would have no tools; the Critic
and Architect must read the codebase, so this is unsuitable alone.

## Decision

Option A. It gives deterministic invariants, straightforward per-role model
config and an artifact written by trusted code. Option B is the fallback if
delegation cannot be issued from a command or tool context. Option C is
rejected for the reasons OMC's own skill spends most of its text guarding
against (parallelized reviews, leaked Architect output).

## Consequences

- Hard dependency on pi-subagents being installed (detected at session
  start, reported as a warning).
- Foreground-only: `/ralplan` blocks the session for the duration; async
  would require option B.
- The delegation contract is copied locally (type-only) because separately
  installed pi packages are not node dependencies of each other.
