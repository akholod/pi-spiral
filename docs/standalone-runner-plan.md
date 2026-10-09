# Standalone child-agent runner for Spiral and Opium

Status: draft, pending decisions (see the end).

Goal: make Spiral and Opium very reliable and free of any subagent plugin
dependency (`pi-subagents`, `pi-subagentura`), while keeping their current
behavior.

Research notes: `.spiral/research/{pi-subagents,pi-subagentura,opium}.md`.

## How the reference plugins do it

|                   | pi-subagents                                                                                                                      | pi-subagentura                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Child launch      | In-process `createAgentSession` (`src/runs/shared/child-session.ts:403-602`)                                                      | In-process `createAgentSession` (`src/helpers.ts:1073`), plus `pi` processes in tmux/zellij/herdr panes |
| Child extensions  | `DefaultResourceLoader({ noExtensions, systemPrompt, extensionsOverride })`; parent extensions load only when explicitly selected | Ambient extensions; recursion bounded by a depth limit in async context                                 |
| Structured output | Child must call the `structured_output` tool, otherwise `structured_output_failed`                                                | Same idea: a capture tool                                                                               |
| Shutdown          | `abort` → `session_shutdown` to extensions (5 s cap) → `dispose`; child creation is serialized                                    | `AbortController`, timeout classification, cancellation tree                                            |

Both keep most of their complexity around the launch, not in it: panes,
rehydration after restart, workflows, external CLI agents. Spiral and Opium
need almost none of it.

## What the two plugins actually use

| Capability                                                    | Spiral                     | Opium                                                        |
| ------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| Foreground child with a result                                | yes, every role            | yes, `/council`                                              |
| Structured JSON result                                        | yes: critic, PRD, reviewer | no                                                           |
| Parallel children                                             | no                         | yes, 3 councillors                                           |
| Read-only vs writer roles                                     | yes                        | yes                                                          |
| Model and thinking per role                                   | yes                        | yes                                                          |
| Background children with completion notification to the model | no                         | yes, orchestrator prompt (`src/prompt.ts:173-181`)           |
| MCP and web tools in children                                 | no                         | yes: explorer, librarian (`mcp:codegraph`, `web_search`)     |
| Forked context, steer/resume, external CLI agents             | no                         | only mentioned in the model's instructions, not used in code |

## Architecture

A shared runner library (working name `pi-agent-runner`): a plain npm
library, not a Pi extension. `@earendil-works/pi-coding-agent` is a
`peerDependency`; both plugins depend on the library directly.

```ts
runAgent({
  cwd, systemPrompt, tools, model, thinking,
  extensions: 'none' | { packages: string[] }, // + provider extension
  result: { kind: 'text' } | { kind: 'structured', schema },
  timeoutMs, signal, onUpdate, transcriptPath?,
}) → { status, value, usage, error, transcript }
```

Decisions inside the runner:

1. **In-process child through the SDK.** The proven path in both reference
   plugins. `DefaultResourceLoader` with `noExtensions`, `noPromptTemplates`,
   `noThemes` and the role's `systemPrompt`; in-memory session.
2. **No recursion by construction.** Spiral children load no extensions.
   Opium specialists load ambient extensions minus Opium itself, filtered
   through `extensionsOverride`. A hard depth limit on top.
3. **Structured output only through a tool.** `submit_result` validates the
   payload against the schema and allows one correction attempt on failure.
   JSON is never parsed out of the final text.
4. **Guaranteed lifecycle.** Overall timeout, `abort` and a time-bounded
   `session_shutdown`, `dispose()` in `finally`, idempotent cleanup. Child
   creation is serialized, as in `pi-subagents`.
5. **Statuses:** `completed | failed | timed_out | cancelled |
structured_output_failed`. Usage is collected from messages; the
   transcript is optionally saved as JSONL.
6. **Time spent waiting for a person is not counted.** Neither the run
   timeout nor the per-tool timeout runs while a permission prompt or any
   other user dialog is open for the child. See "Timeouts and permission
   prompts" below.

### Timeouts and permission prompts

Incident, 2026-10-08: three oracle runs failed with `Tool 'read' exceeded
its timeout` / `Tool 'grep' exceeded its timeout`. The files were small;
the tools never started. Evidence from
`~/.pi/agent/extensions/pi-permission-system/logs/`:

| Run        | Tool call outside `cwd`                                                       | Waiting since | Timeout | User answered                                   |
| ---------- | ----------------------------------------------------------------------------- | ------------- | ------- | ----------------------------------------------- |
| `343703da` | `read ~/pi_sandbox/opium/skills/simplify/SKILL.md`                            | 08:54:47Z     | 300 s   | 09:00:48Z                                       |
| `339a4e34` | `grep ~/.config/opencode`                                                     | 09:34:08Z     | 120 s   | 09:38:33Z                                       |
| `1fa6c4a3` | `grep ~/pi_sandbox/pi-subagents/src` (queued behind the dialog of `339a4e34`) | 09:34:34Z     | 120 s   | auto-approved 09:38:33Z, after the first dialog |

Cause: `pi-permission-system` turned the out-of-`cwd` read into an `ask`
and forwarded it to the parent's dialog. Pi emits `tool_execution_start`
before it runs `beforeToolCall`, the hook where extension `tool_call`
handlers such as the permission gate run
(`pi-agent-core/dist/agent-loop.js:379-384`). pi-subagents starts its
tool timer on `tool_execution_start`, so the wait for the user counted as
tool time. The 120 s limit in runs 2 and 3 was passed explicitly by the
orchestrator and made it worse.

Runner requirement:

- The per-tool wedge timer starts when the tool actually executes: a
  `tool_call` handler registered after every other child extension marks
  the start.
- Both timers pause between `permissions:ui_prompt` and
  `permissions:decision` for the child's session, and while any dialog is
  open on its behalf.
- A child whose permission request is denied or unanswerable (no UI)
  gets a tool error, not a run timeout.
- Read-only agents get an explicit read allowlist (the project roots they
  are asked to inspect), so routine research never needs a dialog.

Stopgap until the migration: Opium's `agents/oracle.md` now has
`timeoutMs: 2700000` and `toolTimeoutMs: 1800000`, and the orchestrator
must not pass a lower `toolTimeoutMs` per call.

This also removes a whole class of bugs in the current integration: with no
event bus there is no `requestId`/`nodeId` correlation, no 30-second start
timeout, no runtime agent registration.

## Phases

| Phase                                | Work                                                                                                                                                                                                                                                                                                                                                                                    | Estimate                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0. Spikes                            | Nested `createAgentSession` from a command handler and from a tool `execute`; models of extension-registered providers (risk 1); "ambient minus self" filter; MCP in a child                                                                                                                                                                                                            | 1–2 days                                        |
| 1. Runner                            | `runAgent`, `submit_result`, timeouts, cancellation, usage, transcript; test suite on a fake session                                                                                                                                                                                                                                                                                    | 3–4 days                                        |
| 2. Spiral                            | New `delegate()` internals, same signature; drop `register-agents.ts` and `Requires pi-subagents`; role definitions move into code                                                                                                                                                                                                                                                      | 1–2 days                                        |
| 3. Opium `/council`                  | Move to `runAgent` with parallel launch; councillor models in config                                                                                                                                                                                                                                                                                                                    | 1 day                                           |
| 4. Opium model-facing tool           | `agent({agent, task, background?, resume?})` plus `agent_status`/`agent_result`/`agent_message`/`agent_cancel`/`agent_revive` (slim parity, see below); background run registry with retained child sessions; completion delivered with `pi.sendMessage` (`triggerTurn` when idle, `deliverAs: "steer"` when busy); own minimal agent frontmatter loader; rewritten orchestrator prompt | 6–9 days                                        |
| 5. Hardening                         | Tests for cancellation races, startup failure, hung tool; manual live check on a real model; optional subprocess backend for writer roles                                                                                                                                                                                                                                               | 2–3 days                                        |
| 6. Opium: slim features never ported | Hooks (job board, idle wake, phase reminder, council mode, JSON error recovery, tool loop guard, `wait_for_user`, the rest after an inventory), model presets, live view of running children; companion window evaluated                                                                                                                                                                | 1.5–3 weeks, firmed up after the inventory task |

Total ≈ 3–4 weeks for phases 0–5, plus 1.5–3 weeks for phase 6. Spiral
is done after phases 0–2 (about 1–1.5 weeks); Opium after phases 3–6.
Spiral additionally needs the `ralph` parity work listed under "Behavior
parity" (about 2–3 days, independent of the runner). The ordered task
list is in `docs/standalone-runner-tasks.md`.

## Main risks

1. **Models of extension-registered providers** (for example
   `claude-bridge`). A fresh `ModelRuntime.create()` does not see them.
   `pi-subagents` copies providers from the parent
   (`inheritParentProviders`). Resolved by T02, see "Spike results"; the
   remaining part is that some providers also need their extension loaded
   in the child.
2. **An in-process child cannot be SIGKILLed.** A hung tool stops only on
   cooperative abort. Mitigation: Pi's `bash` tool already runs in its own
   process with its own timeout. A subprocess backend for writer roles can be
   added later as a second runner implementation.
3. **MCP and web tools in Opium children.** "Ambient minus self" depends on
   how other extensions behave when loaded a second time. Phase 0 spike.
4. **Pi internals may change.** Loader cache resets, `ModelRuntime` details:
   all isolated in one runner module.

## Spike results (phase 0)

Spike code: `~/pi_sandbox/pi-agent-runner/spikes/child.ts` (command
`/spike-child [model|-] [shared|inherit|fresh]`, tool `spike_child`).
Run headless with `pi -p --no-session -e spikes/child.ts "/spike-child ..."`;
extension commands work in print mode. Pi 1.1.0.

### T01. Nested child session

- `createAgentSession` + `DefaultResourceLoader({ noExtensions,
noSkills, noPromptTemplates, noThemes, noContextFiles, systemPrompt })`
  - `SessionManager.inMemory(cwd)` + `bindExtensions({ mode: 'print' })`
    works from a command handler and from a tool `execute`; the parent keeps
    working after the child is disposed (~5 s per child on
    `openai-codex/gpt-6.1-sol`).
- Active handles: one extra `TLSSocket` after the first child, the pooled
  provider connection; it does not grow over further children. Baseline
  check for tests: handle types are stable after the second child, not
  equal to the count before the first one.

### T02. Models from extension-registered providers

| Model                            | shared runtime   | inherit (copy providers) | fresh runtime   |
| -------------------------------- | ---------------- | ------------------------ | --------------- |
| `opencode-go/kimi-k3`            | ok, 2.1 s        | ok, 2.9 s                | ok, 15.5 s      |
| `openai-codex/gpt-6-luna`        | ok, 4.1 s        | ok, 3.2 s                | ok, 17.7 s      |
| `claude-bridge/claude-fable-5-1` | ok with bridge\* | ok with bridge\*         | model not found |

\* `claude-bridge` resolves in the child, but its stream fails with
`prompt-capture: no capture for this ...-char system prompt` unless the
bridge extension itself is loaded in the child: the bridge records the
assembled system prompt from its own `before_agent_start` /
`agent_start` / `turn_start` hooks into a process-wide store and refuses
unknown prompts. With `additionalExtensionPaths: [<pi-claude-bridge>]` the
child answers in ~3.7 s, and a parent bridge turn after the child still
works.

Decisions:

- **Model runtime = inherit**: `ModelRuntime.create()`, copy every parent
  provider from `ctx.modelRegistry` (`getRegisteredProviderIds`,
  `getRegisteredNativeProvider`, `getRegisteredProviderConfig`) that the
  child's own extensions did not register, then
  `refresh({ allowNetwork: false })`. Same speed as sharing. Sharing the
  parent's runtime (private `ModelRegistry.runtime`) is rejected: the
  child's extensions would register providers into the parent's runtime.
  `fresh` alone is slow (~15 s) and misses extension providers.
- **Extension cache reset stays**: set the loader's private `loaded` flag
  before the first `reload()` (pi-subagents' `resetExtensionCacheOnReload`)
  so the child gets its own extension module instances. Without it the
  bridge still answered, but child `session_start` handlers would overwrite
  module-level state of the parent's instance.
- **`inherit`** = the parent's `ctx.model` and `ctx.thinkingLevel`,
  re-resolved by `provider/id` in the child runtime.
- **Provider extensions are loaded even for "no extensions" children.**
  This changes the Spiral rule "children load no extensions": a child
  whose model belongs to an extension-registered provider must load that
  provider's extension and nothing else. Mapping provider → extension path
  is checked in T03.

### T03. Ambient extensions minus self, MCP and web tools

- **Path filtering before load** works:
  `new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve()`
  gives the enabled extension paths a `pi` process would load; filter
  them, then load the rest with `noExtensions: true` +
  `additionalExtensionPaths`. `extensionsOverride` also works, but it runs
  after loading, so excluded extensions (Opium, pi-subagents) still execute
  their factories inside the child. The runner uses path filtering.
- With Opium, Spiral and pi-subagents dropped, the child had
  `web_search` and `codegraph_explore` and called both (codegraph answered
  "no index" for spiral, i.e. the call went through); the system prompt
  had no Opium text. Handle types were the same before and after the
  child, so the MCP adapter's processes were cleaned up by
  `session_shutdown`.
- **Provider → extension mapping cannot be detected by loading.**
  `pendingProviderRegistrations` was empty for the bridge: it registers
  its provider only in the first module instance, or from `session_start`
  when the session's registry lacks it
  (`pi-claude-bridge/src/index.ts:2604-2618`). The runner takes an
  explicit map `providerExtensions: { [providerId]: package }`, default
  `{ 'claude-bridge': 'pi-claude-bridge' }`, and loads the mapped package
  for a child whose model uses that provider, also in "no extensions"
  mode.
- **Skills leak through extensions.** The child prompt had a `<skills>`
  block despite `noSkills: true`: extensions add skills through
  `resources_discover`. The runner must also pass
  `skillsOverride: () => ({ skills: [], diagnostics: [] })` when skills are
  off (pi-subagents does the same). Required for Spiral parity.
- **Inline factories load after path extensions**, so an inline
  `tool_call` handler runs after the permission gate. The runner's "tool
  really started" marker is an inline factory.

Per-extension verdict for children (audit:
`.spiral/research/child-extension-audit.md`; "provisional" = the audit
could not read the whole bundle):

| Extension                                | Verdict                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Opium, Spiral, pi-subagents              | Exclude always (recursion, own prompt/tools)                                             |
| `pi-claude-bridge`                       | Load when the child's model is a bridge model; otherwise optional                        |
| `pi-mcp-adapter`                         | Keep for agents with MCP tools (codegraph); cleans up on shutdown                        |
| `pi-web-access`                          | Keep for web agents; worked in the spike; global `fetch` wrapper to re-check in T11      |
| `@gotgenes/pi-permission-system`         | Keep (enforcement + forwarding, see T04)                                                 |
| `@ff-labs/pi-fff`                        | Keep only when `ffgrep`/`fffind` are wanted; shared frecency DB                          |
| `@juicesharp/rpiv-todo`                  | Keep; state is keyed by session id                                                       |
| `@juicesharp/rpiv-ask-user-question`     | Exclude: the child has no UI                                                             |
| `pi-background-tasks` (both entries)     | Exclude: `bg_*`/`fusion_*` tools spawn agents; attribution swaps a provider process-wide |
| `herdr-agent-state.ts`                   | Exclude: reports pane state of the parent terminal                                       |
| `pi-powerline-footer`, `pi-context-view` | Exclude: UI only; context-view's probe can abort a turn (provisional)                    |
| `pi-simplify`                            | Exclude: command only                                                                    |
| `pi-lens`                                | Exclude by default (provisional: bundle not audited; LSP per instance)                   |

Recommendation: the runner's extension option is an **allowlist by
package name** per agent (`extensions: 'none' | { packages: string[] }`)
plus the implicit provider extension, not "ambient minus a denylist".
A new ambient extension then never reaches children by accident.

### T04. Permission prompts from a runner child

Driven headless through `pi --mode rpc` (`spikes/rpc_driver.py` answers
dialogs after 4 s); `pi-permission-system` loaded in the child; the child
reads `/etc/hostname` (`external_directory_read: ask`).

| Setup                                | Result                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Child not registered as subagent     | Child decides locally (`permissions:ready.adjudicatesLocally: true`), no UI → immediate `deny / confirmation_unavailable` as a tool error |
| Registered, parent with UI (RPC)     | Dialog "Permission Required (Subagent)" reaches the parent; "Yes" → tool runs                                                             |
| Registered, parent without UI (`-p`) | Forwarder waits the serving grace (~2 s), then `deny` as a tool error                                                                     |

Registration: the runner emits on the **parent's** `pi.events`
`subagents:child:session-created { sessionId, parentSessionId }` after
`createAgentSession` and before `bindExtensions`,
`subagents:child:bound` after binding, and `subagents:child:disposed
{ sessionId }` after dispose. The parent's permission-system keeps these in
a process-global registry
(`pi-permission-system/src/authority/subagent-lifecycle-events.ts`).
This is the in-process protocol; pi-subagents instead sets
`PI_SUBAGENT_PARENT_SESSION` in `process.env` and never unsets it. The
runner uses the events.

Event order for one forwarded ask (ms from child start):
`tool_execution_start` 2587 → parent bus `permissions:ui_prompt` 2706
(`forwarding.requesterSessionId` = child id) → parent bus
`permissions:decision` 6714 → child bus `permissions:decision` 6853 →
inline `tool_call` 6864 → `tool_execution_end` 6873. The child bus
never gets `ui_prompt` for a forwarded ask. `tool_execution_start` is
before the permission gate, confirming the incident cause.

Timer hooks for the runner:

- Per-tool timer starts at the inline `tool_call` handler (after every
  gate), stops at `tool_execution_end`.
- Run timer pauses between parent-bus `permissions:ui_prompt` and
  `permissions:decision` whose `forwarding.requesterSessionId` is the
  child's id. Pi core also emits `ui_prompt_start` / `ui_prompt_end` for
  every blocking dialog in the parent; the plugin can forward those as a
  generic "a person is being asked" signal while any child runs.
- The permission-system's agent name is read from an `<active_agent>`
  tag in the system prompt; without it dialogs say `subagent: unknown`.
  Adding the tag changes the role prompt, so for Spiral it stays off.

**Resolved: `claude-bridge` + permission-system forwarder.** A child on a
bridge model that is registered as a subagent failed every turn with
`prompt-capture: no capture ... diverges at offset 56`. In forwarder mode
the permission-system adds `tools`/`rules` sections through
`systemPromptOptions.sections` (`handlers/before-agent-start.ts:136-147`).
Without a returned prompt, Pi sends the system message as sections, and
the text the bridge receives has them in a different order than
`ctx.getSystemPrompt()`, which the bridge captured (`<tools>` right after
the role prompt instead of `<skills>`; same length, different text).

pi-subagents avoids this as a side effect: its prompt-boundary hook is
installed after every other extension and returns `systemPrompt` from
`before_agent_start` (`pi-subagents/src/runs/shared/subagent-prompt-runtime.ts:249-255`).
A returned prompt is frozen for the run, so the bridge's capture and the
request carry the same string. pi-subagentura has no permission-system
integration.

Runner requirement: an inline extension loaded last whose
`before_agent_start` returns `{ systemPrompt: event.systemPrompt }`
unchanged. The frozen text already contains the permission-system's
sections, and the role prompt is not altered, so Spiral parity holds.
Verified live: bridge child registered as subagent, forwarded `ask`
answered "Yes" in the parent, `read` ran (`spikes/child.ts`,
`SPIKE_FREEZE=1`); also checked on `openai-codex/gpt-6-luna` and on a
bridge child without permission-system. Trade-off, same as pi-subagents:
prompt sections an extension adds after `before_agent_start` (for example
Pi's built-in `<mcp_servers>`, disabled here) do not reach the model
during that run.

### T08. Structured output, live finding

`submit_result` must not return `terminate: true` (pi-subagents'
`structured_output` does). With a `claude-bridge` model the run ends
inside the tool, but the bridge's Claude Code query stays open: a
`claude` child process survives `dispose()` and keeps the parent `pi`
process alive (`pi -p` never exits). Without `terminate` the tool answers
"Result recorded… reply with one word: done", the model ends the turn,
and nothing is left behind. Cost: one short extra model reply per
structured run. Verified on openai-codex, opencode-go and claude-bridge
(with and without permission-system), including invalid-then-fixed.

### Permission asks policy (decided 2026-10-09)

slim (`eb99df0f`) gives read-only roles no reason to ask: a deny-all base
plus explicit allows (`src/agents/permissions.ts`,
`createReadOnlyAgentPermission`). Writer roles keep `ask`; a background
child's ask wakes the orchestrator, and a person in the UI or the
orchestrator model answers it with `task_reply` (`once | always | reject`,
`src/tools/task-reply.ts`).

Runner: `permissionAsks: 'forward' | 'deny'`, default `forward`, the
same behavior children have today under pi-subagents: the user's
permission config is the autonomy boundary, `ask` reaches a person, and the
timers pause meanwhile (T07). `deny` leaves the child unregistered with
pi-permission-system, so it decides alone with no UI: `allow` passes,
`deny` and `ask` are refused at once as tool errors; it is meant for runs
nobody is watching. Live check, read of `/etc/hostname` (`ask`): `deny`
refused with no dialog on openai-codex and claude-bridge, `forward` opened
the dialog and waited.

Defaults: `forward` in Spiral and Opium. An all-`deny` default was
rejected: an executor would stop at the first `rm`/`chmod` the user would
simply approve, which breaks autonomy. `deny` is opt-in: a
`spiral.config` setting for unattended ralph runs, an Opium agent
frontmatter field. Asks about reads outside cwd are better removed with
`allow` rules and `readRoots` than refused. An orchestrator-side
`agent_reply` like slim's `task_reply` is a phase 4 candidate. Caveat: pi-permission-system also treats a process
with `PI_SUBAGENT_PARENT_SESSION` set as a child; pi-subagents clears it in
root hosts (`pi-subagents/src/extension/index.ts:985`), so it matters only
inside pi-subagents' own detached runners.

## Open decisions

1. **Where the runner lives:** decided 2026-10-08: a separate
   repository/npm package at `~/pi_sandbox/pi-agent-runner`, Pi packages
   as peerDependencies; Spiral and Opium depend on it (locally via
   `file:`).
2. **Opium phase 4 scope:** resolved by the slim parity review. Message
   (queue/steer), cancel that keeps the session, and revive of a retained
   session are in scope; slim relies on them. Forked context is out: slim
   passes context through the task prompt, and Oracle's `defaultContext:
fork` is an Opium-only addition.
3. **Coexistence:** decided 2026-10-08: if `pi-subagents` is installed
   alongside, the plugins ignore it and always use the runner.

## Behavior parity

### Spiral vs oh-my-claudecode v5.6.2 (2026-10-06)

Spiral was ported around 2026-09-23. Since then OMC changed only
`skills/ralph/SKILL.md` (commits `ed495e643`, `083649f60`, `be5e87f7d`,
`4f97d020e`). `skills/ralplan`, `skills/plan` and `agents/{planner,
architect,critic}.md` are unchanged since the port.

#### ralplan

No drift. The migration keeps behavior only if the child prompt is
composed exactly as now. pi-subagents runtime agents use
`systemPromptMode: replace` with no inherited project context and no
skills catalog (`pi-subagents/docs/agents.md:345-422`). The runner must
match: role prompt as the whole `systemPrompt`, `noContextFiles: true`,
`noSkills: true`, read-only tools `read, grep, find, ls`.

#### ralph

| OMC now                                                                                                                                                                                                                                                                            | Spiral now                                                                                                                                 | Gap                                                                                  | Fix                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feedback baseline: failures present before the run are recorded once; later gates block only on new failure signatures (normalized: ANSI, durations, tmp paths, hex ids); a baseline failure in a file the story touches counts as new; an unrunnable command is its own signature | Every gate requires all `verify` commands to exit 0 (`src/ralph/loop.ts:429-436, 538-559, 585-590`); only a git dirty-file baseline exists | Major: a repo with pre-existing failures spins until `MAX_STORY_ATTEMPTS` and blocks | Baseline run at start, per-command failure signatures, diff at every gate (story, pre-review, post-cleanup). Fits Spiral's "loop in code" ADR; OMC moved the same logic into code (`omc ralph verify`) |
| Stories ordered by risk class: architecture, integration, spikes, standard work, polish last; next story = earliest open one                                                                                                                                                       | PRD prompt says "foundational work first, dependent work later" (`src/ralph/prompts.ts:63-64`)                                             | Minor                                                                                | Update the PRD prompt; selection by list order already matches                                                                                                                                         |
| PRD `repoQualityClass` (`prototype` / `production` default / `library`) scales acceptance strictness; `library` requires a backward-compatibility check on public surfaces                                                                                                         | Missing                                                                                                                                    | Minor                                                                                | Add the field to the PRD schema and state, pass it into executor and reviewer prompts                                                                                                                  |
| PRD `feedbackCommands` override, else detected package scripts                                                                                                                                                                                                                     | `ralph.verify` config, else PRD `verify` confirmed by the user (`src/ralph/index.ts:182-199`)                                              | None (equivalent)                                                                    | Keep; it is stricter about running PRD-proposed commands                                                                                                                                               |
| Terminal closeout: at most 3 factual lines to `.omc/notepads/ralph/problems.md`, blockers to `issues.md`, also on cancel                                                                                                                                                           | Missing                                                                                                                                    | Minor                                                                                | Append closeout lines under `.spiral/` on every terminal outcome                                                                                                                                       |
| Terminal incident item on a stop-and-report halt                                                                                                                                                                                                                                   | `blockers` note in the result                                                                                                              | Minor                                                                                | Write the failure signature, evidence pointers and reopen path                                                                                                                                         |
| Opt-in token budget stop (90% warn, 100% resumable stop)                                                                                                                                                                                                                           | Usage is collected but not budgeted                                                                                                        | Minor                                                                                | Optional `ralph.budgetTokens` checked at iteration boundaries                                                                                                                                          |
| Draft PR on completion when explicitly authorized                                                                                                                                                                                                                                  | Never commits (ADR 0003)                                                                                                                   | Intentional divergence                                                               | Keep; document                                                                                                                                                                                         |
| Git guardrails during active modes (block push, `reset --hard`, `clean -f`, `branch -D`, discards)                                                                                                                                                                                 | Executor and cleaner have `bash` with no guard                                                                                             | Medium                                                                               | New capability of the in-process runner: a child-only `tool_call` guard extension that blocks these commands                                                                                           |

Migration-specific risks for Spiral: structured output moves from
pi-subagents' `structured_output` tool to the runner's `submit_result`, so
role prompts and tests that name the tool must change; executor and
cleaner must keep exactly Pi's default tool set; operator settings
`subagents.defaultModel`/`agentOverrides` stop applying, so `inherit` must
resolve to the parent session model.

Acceptance checks:

- ralplan: the same critic schema and verdict downgrade, 5-iteration cap,
  sequential architect then critic on one snapshot, interactive
  checkpoints, cancel mid-role.
- ralph: baseline with a pre-existing failing test passes stories that add
  no new failures; a new failure blocks; a reviewer rejection reopens
  stories; cleanup regression triggers bounded repair; resume after cancel.
- Runner: read-only roles cannot call `bash`/`edit`/`write`; executor
  cannot run `git push` or `git reset --hard`; timeout and cancel leave no
  live child session.

### Opium vs oh-my-opencode-slim (HEAD `eb99df0f`, 2026-10-08)

Sources: `oh-my-opencode-slim/docs/background-orchestration.md`,
`docs/council.md`, `src/agents/orchestrator.ts`, `src/config/constants.ts`,
`src/tools/task-*.ts`; full notes in `.spiral/research/slim-contract.md`.

Today Opium gets slim's background contract from pi-subagents (async
runs, completion delivery, status, steer, resume, stop). Removing
pi-subagents without replacing each of these would make Opium behave less
like slim, not more. Rows marked "migration" must hold after the work;
rows marked "existing gap" were never ported and are now in scope as
phase 6.

| slim                                                                                                                                                                  | Opium now                                         | After migration                                                                                      | Kind                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `task(..., background: true)` returns a task id at once                                                                                                               | `subagent` (pi-subagents), agents `async: true`   | `agent({ background: true })` returns a run id                                                       | Migration                               |
| Terminal result injected into the parent: new turn when idle, steer when busy                                                                                         | pi-subagents notification                         | `pi.sendMessage` with `triggerTurn` or `deliverAs: "steer"`                                          | Migration                               |
| `task_status`, `task_result`                                                                                                                                          | pi-subagents `status`                             | `agent_status`, `agent_result`                                                                       | Migration                               |
| `task_message`: non-interrupting message, queue or steer, acceptance is not consumption                                                                               | pi-subagents `steer`                              | `agent_message` through `session.followUp` / `session.steer`                                         | Migration                               |
| `task_cancel` stops a generation and keeps the session                                                                                                                | pi-subagents `stop`                               | `agent_cancel` through `session.abort`, session retained                                             | Migration                               |
| `task_revive` continues the same session with a new instruction; explicit resume id is never dropped                                                                  | pi-subagents `resume`                             | `agent_revive` / `agent({ resume })` prompts the retained session                                    | Migration                               |
| Spawn refused while an unreconciled terminal job has the same agent and objective                                                                                     | Missing                                           | Same refusal in the registry                                                                         | Migration (cheap, prevents loops)       |
| At most 2 retained sessions per agent (`DEFAULT_MAX_SESSIONS_PER_AGENT`)                                                                                              | n/a                                               | Same cap with eviction of the oldest terminal session                                                | Migration                               |
| Opt-in wall-clock timeout with abort grace; outcome `timedOut`                                                                                                        | Per-agent `timeoutMs` in frontmatter              | Runner timeout, same outcome naming                                                                  | Migration                               |
| Post-restart recovery is partial and best-effort                                                                                                                      | pi-subagents persistence                          | Process-local registry; child sessions persisted to files so `agent_revive` can reopen after restart | Migration (simpler, documented)         |
| Council: seats in parallel, synthesizer with no tools, partial success synthesizes, all-failed lists seats                                                            | Same (`src/council.ts:104-219`)                   | Same on `runAgent`                                                                                   | Migration                               |
| Council: per-seat model fallback chain; empty answer retried once per entry                                                                                           | One model per seat, no retry                      | Add fallback list and one empty-answer retry                                                         | Existing gap, cheap to close in phase 3 |
| Default MCPs: librarian `context7`, `gh_grep`; others none; orchestrator all                                                                                          | Agent `tools` incl. `mcp:codegraph`, `web_search` | Same allowlists, enforced by the runner                                                              | Migration (phase 0 spike)               |
| Hooks: phase reminder, job board injection, orchestrator idle wake (5 min, todo-gated, 2-wake no-progress cap), JSON error recovery, tool loop guard, `wait_for_user` | Only the orchestrator prompt toggle               | Unchanged                                                                                            | Existing gap                            |
| Multiplexer panes, companion window, presets                                                                                                                          | Missing                                           | Unchanged                                                                                            | Existing gap, optional in slim          |

Migration-specific risks for Opium:

- The orchestrator prompt (`src/prompt.ts:108-110, 173-181`) names the
  `subagent` tool and its actions; it must be rewritten for the new tools
  in the same change, and the system-prompt roster must list only agents
  the new loader accepts.
- Agent frontmatter keeps only fields Opium implements: `description`,
  `model`, `thinking`, `tools`, `skills`, `timeoutMs`, `background`.
  pi-subagents-only fields (`advertise`, `acceptanceRole`,
  `defaultContext`, `inheritProjectContext`) are dropped or mapped.
- If pi-subagents stays installed, both tool sets are visible to the
  model; the prompt must name only Opium's tools, and tool names must not
  collide.
- `PI_SUBAGENT_CHILD` (`extensions/opium.ts:42-46`) is no longer set;
  children are recognized by the runner's own marker instead.

Acceptance checks:

- Two background explorers run in parallel; each completion wakes an idle
  parent once, and steers a busy parent instead of starting a new turn.
- `agent_message` to a running fixer is accepted without interrupting it.
- `agent_cancel` keeps the session; `agent_revive` continues it with the
  earlier transcript.
- A repeated spawn with the same agent and objective is refused until the
  previous result is read.
- Council with one failing seat synthesizes from two and marks the third;
  with all seats failing it reports every seat and no synthesis.
- Explorer has codegraph, librarian has web search, councillors have only
  read-only tools, the council synthesizer has none.
- No Opium orchestrator prompt is injected into any child.
