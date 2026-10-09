# Standalone runner: task list

Ordered tasks for `docs/standalone-runner-plan.md`. Do them top to bottom
unless "Depends on" allows otherwise. Each task is done when every
acceptance check passes and the listed validation is green.

Conventions:

- **Runner** = the shared library (working name `pi-agent-runner`).
- **Where**: `runner`, `spiral`, `opium`, or `docs`.
- Status: `[ ]` open, `[x]` done.

## Phase 0. Decisions and spikes

### [x] T00. Close the open decisions

- **Where:** docs
- **Work:** decide D1 (runner as a separate npm package or a copied
  module) and D3 (ignore `pi-subagents` when installed alongside, or use
  it). Record the answers in the plan's "Open decisions".
- **Done when:** both decisions are written down; T05 knows where the
  runner lives.

### [x] T01. Spike: nested child session

- **Where:** throwaway extension under `runner/spikes/`
- **Depends on:** none
- **Work:** from a slash-command handler and from a tool `execute`, create
  a child with `createAgentSession` + `DefaultResourceLoader({ noExtensions:
true, noPromptTemplates: true, noThemes: true, systemPrompt })` and an
  in-memory `SessionManager`; prompt it, read the final text, emit
  `session_shutdown`, dispose.
- **Done when:** both entry points return the child's text with a real
  model; the parent session keeps working; no timers or handles remain
  (`process._getActiveHandles()` count back to baseline).

### [x] T02. Spike: models from extension-registered providers

- **Where:** spike
- **Depends on:** T01
- **Work:** resolve `claude-bridge/claude-fable-5-1`, `opencode-go/kimi-k3`
  and `openai-codex/gpt-6-luna` in the child. Compare passing the parent's
  model runtime with copying providers (pi-subagents'
  `inheritParentProviders`). Define `inherit` = the parent session's
  current model and thinking level.
- **Done when:** all three models answer in a child; the chosen approach
  and its Pi APIs are noted in the plan.

### [x] T03. Spike: ambient extensions minus self, MCP and web tools

- **Where:** spike
- **Depends on:** T01
- **Work:** load ambient extensions in a child with an `extensionsOverride`
  that drops Opium, Spiral and pi-subagents; check `codegraph` (via
  `pi-mcp-adapter`) and `web_search` (`pi-web-access`). List extensions
  that misbehave when loaded twice (footer, lens, background tasks, todo,
  permission system) and need excluding.
- **Done when:** the child sees `codegraph` and `web_search`, does not see
  Opium's prompt or tools; the exclusion list is written in the plan.

### [x] T04. Spike: permission prompts from a runner child

- **Where:** spike
- **Depends on:** T03
- **Work:** with `pi-permission-system` loaded in the child, trigger an
  `ask` (read outside `cwd`). Record which events fire
  (`permissions:ui_prompt`, `permissions:decision`), whether the prompt
  reaches the parent dialog, and what happens without a UI. Confirm the
  order `tool_execution_start` → `beforeToolCall` for the child.
- **Done when:** the plan records the forwarding behavior and the exact
  hook points the runner uses to pause timers (see "Timeouts and
  permission prompts").

## Phase 1. Runner

### [x] T05. Package skeleton

- **Where:** runner
- **Depends on:** T00
- **Work:** package with `@earendil-works/pi-coding-agent`, `pi-ai`,
  `typebox` as `peerDependencies` (`*`); TypeScript, ESLint/Prettier and
  `node --test` set up like Spiral; README with the API sketch.
- **Done when:** `npm run typecheck`, `npm run lint`, `npm test` pass on an
  empty test.

### [x] T06. `runAgent` core

- **Where:** runner
- **Depends on:** T01, T02, T05
- **Work:** session creation (serialized), prompt composition (`replace`
  by default; options `noContextFiles`, `noSkills`), model and thinking
  resolution including `inherit`, final text, usage from messages,
  statuses `completed | failed | timed_out | cancelled |
structured_output_failed`, shutdown (`session_shutdown` with a 5 s cap)
  and `dispose()` in `finally`. Child registration on the parent's
  `pi.events` (`subagents:child:session-created` / `bound` /
  `disposed`, plan T04) and a last-loaded inline hook that freezes the
  system prompt in `before_agent_start` (plan, "Resolved: claude-bridge +
  permission-system forwarder").
- **Done when:** fake-session tests cover every status except
  `structured_output_failed` (needs `submit_result`, T08); a disposed child
  never emits events afterwards. Takes `parent: { events, ctx }` explicitly;
  Spiral threads its `ctx` through in T12.

### [x] T07. Timeouts and cancellation

- **Where:** runner
- **Depends on:** T04, T06
- **Work:** run timeout; per-tool wedge timeout that starts in a
  `tool_call` handler registered last; both paused during permission
  prompts; `AbortSignal` propagation; idempotent cleanup; a denied or
  unanswerable permission becomes a tool error.
- **Done when:** tests: a tool waiting on a simulated permission prompt for
  longer than the tool timeout does not time out; a truly hung tool does;
  cancel during startup, during a tool and during the final answer all end
  as `cancelled` with no live session.

### [x] T08. Structured output

- **Where:** runner
- **Depends on:** T06
- **Work:** `submit_result` tool built from the JSON schema; validation;
  one correction turn on invalid input; `structured_output_failed` when no
  valid call arrives.
- **Done when:** tests for valid, invalid-then-fixed, never-called and
  called-twice cases.

### [x] T09. Tool policy and guards

- **Where:** runner
- **Depends on:** T03, T06
- **Work:** tool allowlist per call; extension mode `none` or `{
packages }` (allowlist by package name, see plan T03) plus the implicit
  provider extension; `skillsOverride` when skills are off; child-only guard extension for writer roles that
  blocks `git push`, `git reset --hard`, `git clean -f`, `git branch -D`,
  `git checkout -- .`, `git restore .`; nesting depth limit; read
  allowlist for read-only roles.
- **Done when:** tests: read-only child cannot call `bash`, `edit`,
  `write`; writer child gets an error for each blocked git command;
  depth limit stops recursion.

### [x] T10. Progress and transcript

- **Where:** runner
- **Depends on:** T06
- **Work:** `onUpdate` with current tool, turn count and tokens; optional
  JSONL transcript; artifacts cleaned up when transcripts are off.
- **Done when:** tests check update order and that no temp files remain.

### [x] T11. Live smoke test

- **Where:** runner
- **Depends on:** T07, T08, T09, T10
- **Work:** an opt-in test (`RUNNER_LIVE=1`) that runs a text child, a
  structured child and a cancelled child against a real model.
- **Done when:** passes locally with two different providers.

## Phase 2. Spiral on the runner

### [x] T12. Replace `delegate()` internals

- **Where:** spiral `src/subagents/delegation.ts`
- **Depends on:** T11
- **Work:** keep the `delegate()` signature and `DelegationResponse`
  shape; implement with `runAgent`. Role definitions (prompt file, tools,
  description) move from `register-agents.ts` into a role table used by
  `delegate()`. Prompt parity: role prompt replaces the system prompt,
  `noContextFiles`, `noSkills`, read-only roles `read, grep, find, ls`,
  executor and cleaner get Pi's default tools plus the git guard. Roles use
  `permissionAsks: 'forward'`; a `spiral.config` setting switches all
  roles to `deny` for unattended runs (plan, "Permission asks policy").
- **Done when:** `npm test`, `npm run typecheck`, `npm run lint` pass;
  no import of the pi-subagents event names remains.

### [x] T13. Remove pi-subagents from Spiral

- **Where:** spiral
- **Depends on:** T12
- **Work:** delete `register-agents.ts` registration and the
  `session_start` registration block in `extensions/spiral.ts`; replace
  `structured_output` mentions with `submit_result` in prompts and tests;
  update `README.md` (drop "Requires pi-subagents"), `docs/ARCHITECTURE.md`
  and the ADRs that describe delegation.
- **Done when:** `grep -ri "pi-subagents" spiral/src spiral/extensions
spiral/README.md` returns nothing; checks green.

### [ ] T14. ralplan acceptance checks

- **Where:** spiral tests + one live run
- **Depends on:** T13
- **Done when:** same critic schema and verdict downgrade; 5-iteration
  cap; architect then critic on one plan snapshot; interactive
  checkpoints; `/ralplan-cancel` mid-role leaves no live child; one live
  `/ralplan` on this repo produces a plan artifact.

## Phase 2b. ralph parity with oh-my-claudecode v5.6.2

Independent of the runner; can run in parallel with phases 0–2.

### [ ] T15. Feedback baseline

- **Where:** spiral `src/ralph/verify.ts`, `loop.ts`, `state.ts`
- **Work:** run `verify` commands once at start and store per-command
  failure signatures (strip ANSI; normalize durations, timestamps, tmp
  paths, hex ids; drop progress lines; dedupe; cap). At every gate (story,
  pre-review, post-cleanup) block only on new signatures; a baseline
  failure in a file the current story touches counts as new; a command
  that cannot run is its own signature. Baseline failures are reported as
  warnings.
- **Done when:** tests: pre-existing failing test → stories pass; new
  failure → story fails; failure in a touched file → story fails;
  resume keeps the baseline.

### [ ] T16. Risk-ordered stories and `repoQualityClass`

- **Where:** spiral `src/ralph/prompts.ts`, `prd.ts`
- **Work:** PRD prompt orders stories by risk (architecture, integration,
  spikes, standard, polish last); PRD field `repoQualityClass`
  (`prototype | production | library`, default `production`) kept through
  every PRD write and passed to executor and reviewer prompts; `library`
  adds a backward-compatibility criterion for public surfaces.
- **Done when:** schema, normalizer and survival tests pass.

### [ ] T17. Closeout, incident item, token budget

- **Where:** spiral `src/ralph/*`
- **Work:** on every terminal outcome append at most three factual lines
  to `.spiral/notes/ralph/problems.md` (blockers also to `issues.md`);
  on a stop-and-report halt write a failure signature, evidence pointers
  and reopen path; optional `ralph.budgetTokens` (warn at 90%, resumable
  stop at 100%).
- **Done when:** tests for each outcome; empty closeout writes nothing.

### [ ] T18. ralph acceptance checks

- **Where:** spiral tests + one live run
- **Depends on:** T13, T15, T16, T17
- **Done when:** reviewer rejection reopens stories; cleanup regression
  triggers bounded repair; resume after cancel works; executor cannot run
  blocked git commands; one live `/ralph` run on a scratch repo with a
  pre-existing failing test completes.

## Phase 3. Opium council

### [ ] T19. Council on the runner

- **Where:** opium `src/council.ts`, `src/delegation.ts`
- **Depends on:** T11
- **Work:** seats in parallel through `runAgent` with read-only tools;
  synthesizer with no tools; keep partial-success and all-failed behavior.
- **Done when:** existing council tests pass against the new runner fake.

### [ ] T20. Seat model fallback and empty-answer retry

- **Where:** opium
- **Depends on:** T19
- **Work:** each seat takes an ordered model list; an empty answer is
  retried once per model; other failures move to the next model; a seat
  fails only after the list is exhausted.
- **Done when:** tests for fallback, empty retry and exhaustion.

## Phase 4. Opium model-facing tools

### [ ] T21. Agent definitions

- **Where:** opium `src/agents.ts` (new)
- **Depends on:** T11
- **Work:** loader for `agents/*.md` with fields `description`, `model`,
  `thinking`, `tools`, `skills`, `timeoutMs`, `toolTimeoutMs`,
  `background`, `permissionAsks` (default `forward`; `deny` only where the agent file
  says so), `gitGuard`
  (off only for fast-generic, which pushes on request); per-agent model/thinking overrides from Opium config;
  map or drop pi-subagents-only fields.
- **Done when:** every current agent file loads; invalid frontmatter fails
  with a clear error.

### [ ] T22. Run registry

- **Where:** opium
- **Depends on:** T21
- **Work:** background runs with ids; retained child sessions persisted to
  session files (the runner's `transcriptPath` already writes a Pi session
  file that `SessionManager.open` continues with full history, verified in
  T10; revive needs a runner option to open an existing file); at most 2 retained sessions per agent with eviction of
  the oldest terminal one; refuse a new spawn with the same agent and
  objective while an unread terminal result exists; dispose everything on
  parent `session_shutdown`.
- **Done when:** unit tests for caps, eviction, duplicate refusal and
  shutdown.

### [ ] T23. Tools

- **Where:** opium
- **Depends on:** T22
- **Work:** `agent({ agent, task, background?, resume? })`,
  `agent_status`, `agent_result`, `agent_message` (queue or steer;
  acceptance is not consumption), `agent_cancel` (abort, keep session),
  `agent_revive` (new instruction to a retained session; never drops an
  explicit resume id).
- **Done when:** tool-level tests for each action and its error cases.

### [ ] T24. Completion delivery

- **Where:** opium
- **Depends on:** T23
- **Work:** on terminal state call `pi.sendMessage` with `triggerTurn`
  when the parent is idle and `deliverAs: "steer"` when it is busy; one
  delivery per run generation; failures retried within a small bound.
- **Done when:** tests: idle parent gets one new turn; busy parent gets a
  steer; a revived run delivers again only for the new generation.

### [ ] T25. Orchestrator prompt and child marker

- **Where:** opium `src/prompt.ts`, `extensions/opium.ts`, `README.md`
- **Depends on:** T23
- **Work:** rewrite the delegation section for the new tools; roster from
  the T21 loader; replace the `PI_SUBAGENT_CHILD` check with the runner's
  child marker; README without the pi-subagents requirement.
- **Done when:** prompt tests updated; no `subagent(` mention remains in
  the prompt.

### [ ] T26. Opium acceptance checks

- **Where:** opium tests + live session
- **Depends on:** T20, T24, T25
- **Done when:** the Opium acceptance list in the plan passes, including
  two parallel explorers, message to a running fixer, cancel then revive,
  duplicate refusal, council partial failure, per-agent tools, and no
  orchestrator prompt in children.

## Phase 5. Hardening

### [ ] T27. Failure-path tests

- **Where:** runner, spiral, opium
- **Depends on:** T14, T18, T26
- **Work:** cancellation races (startup, tool, structured output),
  provider errors, parent reload and session replacement during a
  running child, permission prompt during a run.
- **Done when:** all pass three times in a row with shuffled test order.

### [ ] T28. Live check without pi-subagents

- **Where:** local Pi settings
- **Depends on:** T27
- **Work:** remove `npm:pi-subagents` from `~/.pi/agent/settings.json`,
  run `/ralplan`, `/ralph`, `/council` and an orchestrated Opium task;
  then reinstall it and repeat to check coexistence (D3).
- **Done when:** both configurations work; findings recorded.

### [ ] T29. Optional subprocess backend

- **Where:** runner
- **Depends on:** T28
- **Work:** second backend running `pi --mode json` in a process group for
  writer roles, so a wedged child can be killed with SIGKILL.
- **Done when:** a test kills a child stuck in a tool; decision recorded
  on whether it becomes the default for writers.

## Phase 6. Opium: slim features never ported

### [ ] T30. Inventory of slim hooks and tools

- **Where:** docs
- **Work:** for every directory in `oh-my-opencode-slim/src/hooks` and
  `src/tools`, record what it does, whether it applies to Pi, whether Pi
  or an installed extension already covers it, and the port decision.
- **Done when:** the table is in the plan and T31–T37 are confirmed or
  adjusted.

### [ ] T31. Job board and idle wake

- **Where:** opium
- **Depends on:** T24, T30
- **Work:** compact job board injected into orchestrator turns when it
  changed; idle wake every 5 minutes while background runs are unfinished
  or results are unread, with a 2-wake no-progress cap; `wait_for_user`
  tool that suppresses wakes until the next real user message.
- **Done when:** tests for injection, wake, cap and `wait_for_user`.

### [ ] T32. Phase reminder and council mode

- **Where:** opium
- **Depends on:** T30
- **Work:** port the phase reminder and council-mode instruction
  injection as slim does them.
- **Done when:** tests check when each injection fires.

### [ ] T33. JSON error recovery and tool loop guard

- **Where:** opium
- **Depends on:** T30
- **Work:** recover from malformed tool arguments the way slim does;
  detect repeated identical tool calls and nudge the model.
- **Done when:** tests for both.

### [ ] T34. Remaining portable hooks

- **Where:** opium
- **Depends on:** T30
- **Work:** whatever T30 marks portable (candidates: deepwork, reflect,
  loop command, search path guard, model fallback).
- **Done when:** each ported hook has tests; skipped ones have a reason
  in the plan.

### [ ] T35. Model presets

- **Where:** opium
- **Depends on:** T21
- **Work:** named presets of per-agent models and thinking levels in
  Opium config; `/opium-preset <name>` and a tool to switch at runtime.
- **Done when:** switching changes the models of new runs only.

### [ ] T36. Live view of running children

- **Where:** opium (designer)
- **Depends on:** T22
- **Work:** TUI widget listing running and recent children with agent,
  current tool, duration and tokens; optional herdr/tmux pane attach
  later.
- **Done when:** the designer's acceptance plus a manual check with three
  parallel runs.

### [ ] T37. Companion window

- **Where:** docs
- **Depends on:** T30
- **Work:** evaluate slim's companion desktop window for Pi; decide port
  or skip.
- **Done when:** decision recorded with a reason.
