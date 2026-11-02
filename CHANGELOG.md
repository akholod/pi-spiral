# Changelog

## [0.3.0]

### Changed

- Host runtime binding: the extension now hands the host Pi modules
  (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) to
  `pi-agent-runner` via `bindHostRuntime`. ralplan and ralph subagents run on
  the Pi version you have installed instead of a stale copy bundled in
  `node_modules`.
- Human-wait tracking: Spiral tracks permission prompts on its own events
  facade (`humanWaitTracker`), so subagent timers pause while you answer a
  dialog.
- The Pi packages (`pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) are now
  optional peer dependencies.
- Requires `pi-agent-runner` `^0.11.0` and Pi 1.1.0 or newer.

## [0.2.2]

Previous release.
