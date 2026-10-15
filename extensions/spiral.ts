// Spiral: ralplan + ralph for pi.
//
// Entry point. Responsibilities:
//   - load and validate spiral.json (user + project), fail-closed
//   - delegate each role to a child agent through pi-agent-runner
//   - expose `/ralplan` + `ralplan` tool and `/ralph` + `ralph` tool

import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import {
  mountRunsView,
  registerAgentsCommand,
  type ParentContext,
} from 'pi-agent-runner';
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  builtinCatalog,
  DEFAULT_PRESET,
  loadConfig,
  presetNames,
  resolvePreset,
  type LoadedConfig,
  type ResolvedPreset,
} from '../src/config.ts';
import {
  applyModelOverrides,
  parseRalplanArgs,
  runRalplan,
} from '../src/ralplan/index.ts';
import { preflightModels } from '../src/ralplan/preflight.ts';
import { formatUsage } from '../src/ralplan/artifact.ts';
import type { LoopProgress } from '../src/ralplan/loop.ts';
import {
  PROGRESS_ENTRY_TYPE,
  progressEntry,
  renderProgressText,
  withProgressSummary,
  type ProgressEntryData,
} from '../src/ralplan/summary.ts';
import type {
  CheckpointDecision,
  CheckpointHandler,
  RalplanResult,
} from '../src/ralplan/types.ts';
import {
  applyRalphModelOverrides,
  parseRalphArgs,
  runRalph,
} from '../src/ralph/index.ts';
import type { RalphProgress } from '../src/ralph/loop.ts';
import { formatPrdStatus, prdStatus } from '../src/ralph/prd.ts';
import type { RalphResult } from '../src/ralph/types.ts';

const formatProgress = (progress: LoopProgress): string =>
  withProgressSummary(
    `[ralplan] iteration ${progress.iteration}: ` +
      `${progress.role} ${progress.phase}` +
      `${progress.detail ? ` (${progress.detail})` : ''}`,
    progress.summary,
  );

const isSuccess = (result: RalplanResult): boolean =>
  result.outcome === 'approved' || result.outcome === 'exhausted';

const summarize = (result: RalplanResult): string => {
  const rounds = result.iterations.length;
  const last = result.iterations.at(-1);
  const verdict = last ? last.criticReview.verdict : 'none';
  const lines: string[] = [];
  switch (result.outcome) {
    case 'approved':
      lines.push(`ralplan approved after ${rounds} iteration(s).`);
      lines.push('status: pending approval. Nothing was executed.');
      break;
    case 'exhausted':
      lines.push(
        `ralplan NOT approved: critic verdict ${verdict} after ${rounds} ` +
          'iteration(s) (limit reached).',
      );
      lines.push(
        'status: latest version saved for manual review. Nothing was executed.',
      );
      break;
    case 'rejected':
      lines.push('ralplan rejected by user. No artifact written.');
      break;
    case 'aborted':
      lines.push(`ralplan cancelled after ${rounds} completed iteration(s).`);
      break;
    case 'failed':
      lines.push(
        `ralplan FAILED after ${rounds} completed iteration(s): ` +
          `${result.error}`,
      );
      break;
  }
  if (result.note) lines.push(`note: ${result.note}`);
  if (result.artifactPath) lines.push(`artifact: ${result.artifactPath}`);
  else if (result.outcome !== 'rejected') lines.push('artifact: none written');
  lines.push(`usage: ${formatUsage(result.usage)}`);
  return lines.join('\n');
};

const USAGE =
  'Usage: /ralplan [--preset name] [--deliberate] [--interactive] ' +
  '[--planner m] [--architect m] [--critic m] <task>';

const RALPH_USAGE =
  'Usage: /ralph [--preset name] [--no-deslop] [--reviewer-agent ' +
  'critic|architect] [--plan <artifact>] [--resume [runId]] [--prd m] ' +
  '[--executor m] [--reviewer m] [--cleaner m] <task>';

const PRESET_PARAM = Type.String({
  description:
    'Name of a configured or built-in preset (e.g. lite, deep) that sets ' +
    'role thinking/models and loop limits; "default" = none',
});

const presetLabel = (resolved: ResolvedPreset): string =>
  resolved.preset ? ` (preset ${resolved.preset})` : '';

const notStarted = (label: 'ralplan' | 'ralph', error: string) => ({
  content: [{ type: 'text' as const, text: `${label} not started: ${error}` }],
  details: { outcome: 'not_started' },
  isError: true,
});

const formatRalphProgress = (progress: RalphProgress): string =>
  withProgressSummary(
    `[ralph] iteration ${progress.iteration}: ${progress.role} ` +
      `${progress.phase}${progress.detail ? ` (${progress.detail})` : ''}`,
    progress.summary,
  );

const summarizeRalph = (result: RalphResult): string => {
  const status = prdStatus(result.prd);
  const lines: string[] = [];
  switch (result.outcome) {
    case 'completed':
      lines.push(
        `ralph COMPLETED after ${result.iterations} iteration(s): all ` +
          `${status.total} stories pass and the ` +
          `${result.reviews.length > 0 ? 'reviewer' : 'loop'} verified them.`,
      );
      break;
    case 'exhausted':
      lines.push(
        `ralph NOT complete: budget exhausted after ${result.iterations} ` +
          'iteration(s).',
      );
      break;
    case 'blocked':
      lines.push(
        `ralph BLOCKED after ${result.iterations} iteration(s); user input ` +
          'needed.',
      );
      break;
    case 'aborted':
      lines.push(`ralph cancelled after ${result.iterations} iteration(s).`);
      break;
    case 'failed':
      lines.push(
        `ralph FAILED after ${result.iterations} iteration(s): ${result.error}`,
      );
      break;
  }
  if (result.note) lines.push(`note: ${result.note}`);
  lines.push(formatPrdStatus(status));
  lines.push(
    result.verification === 'none'
      ? 'verification: NONE (no regression commands ran; only executor and ' +
          'reviewer evidence)'
      : `verification: ${result.verification} ` +
          `(${result.verifyCommands.join(' && ')})`,
  );
  if (result.baselineWarnings.length > 0) {
    const warnings = result.baselineWarnings.join(' | ');
    lines.push(
      `pre-existing failures (present before the run, not fixed): ${warnings}`,
    );
  }
  if (result.notes && result.notes.problems + result.notes.issues > 0) {
    lines.push(
      `notes: ${result.notes.problems + result.notes.issues} line(s) ` +
        `appended to ${result.notes.dir}`,
    );
  }
  lines.push(`deslop: ${result.deslop}`);
  lines.push(
    'changed files: ' +
      `${
        result.changedFiles.length > 0
          ? result.changedFiles.join(', ')
          : 'none reported'
      }`,
  );
  lines.push(
    result.outcome === 'completed'
      ? `state: ${result.runDir}`
      : `state: ${result.runDir} (resume with /ralph --resume ${result.runId})`,
  );
  lines.push(
    result.headChanged
      ? 'WARNING: HEAD moved during the run, a child made commits.'
      : 'the loop made no commits (HEAD unchanged).',
  );
  lines.push(`usage: ${formatUsage(result.usage)}`);
  return lines.join('\n');
};

const DRAFT_OPTIONS = ['Proceed to review', 'Request changes', 'Skip review'];
const FINAL_OPTIONS = ['Approve', 'Request changes', 'Reject'];

const makeCheckpointHandler =
  (pi: ExtensionAPI, ctx: ExtensionCommandContext): CheckpointHandler =>
  async (checkpoint, plan): Promise<CheckpointDecision> => {
    const title =
      checkpoint === 'draft'
        ? 'Ralplan: initial draft'
        : 'Ralplan: critic approved';
    // Show the full plan in the transcript before asking; the select
    // dialog itself has no room for it and notifications truncate.
    pi.sendMessage(
      {
        customType: 'spiral-ralplan-checkpoint',
        content: `# ${title}\n\n${plan}`,
        display: true,
      },
      { triggerTurn: false },
    );
    const options = checkpoint === 'draft' ? DRAFT_OPTIONS : FINAL_OPTIONS;
    const choice = await ctx.ui.select(title, options);
    if (choice === 'Request changes') {
      const feedback = await ctx.ui.input('What should change?');
      if (feedback && feedback.trim() !== '') {
        return { action: 'changes', feedback: feedback.trim() };
      }
      return { action: 'proceed' };
    }
    if (choice === 'Skip review') return { action: 'skip' };
    if (choice === 'Reject' || choice === undefined) {
      return { action: 'reject' };
    }
    return { action: 'proceed' };
  };

export default function spiralExtension(pi: ExtensionAPI) {
  pi.registerEntryRenderer<ProgressEntryData>(
    PROGRESS_ENTRY_TYPE,
    (entry, _options, theme) =>
      entry.data
        ? new Text(
            renderProgressText(entry.data, (color, text) =>
              theme.fg(color, text),
            ),
            0,
            0,
          )
        : undefined,
  );

  // 'finished' events persist in the transcript (never sent to the model);
  // 'started' ones are transient notifications.
  const persistFinished = (
    progress: { phase: 'started' | 'finished'; detail?: string },
    text: string,
  ): boolean => {
    if (progress.phase !== 'finished') return false;
    pi.appendEntry(PROGRESS_ENTRY_TYPE, progressEntry(text, progress.detail));
    return true;
  };

  let loaded: LoadedConfig | null = null;
  let runsView: { dispose(): void } | undefined;
  const parentOf = (ctx: ExtensionContext): ParentContext => ({
    events: pi.events,
    ctx,
  });

  // Controllers of running /ralplan commands, so `/ralplan-cancel` can
  // stop them: a slash-command ctx.signal is usually undefined.
  const running = new Set<AbortController>();

  // `/spiral-preset` choice; in memory, reset on session_start.
  let sessionPreset: string | undefined;

  // Preset in effect for one run: explicit > session > defaultPreset.
  const resolveFor = (cfg: LoadedConfig, requested?: string): ResolvedPreset =>
    resolvePreset(cfg.config, cfg, { requested, session: sessionPreset });

  // Completes the name after `--preset `; value replaces the whole argument
  // text (pi passes the full argument string as the prefix).
  const completePreset = (argumentPrefix: string) => {
    const match = /(^|\s)--preset\s+(\S*)$/.exec(argumentPrefix);
    if (!match) return null;
    const typed = match[2];
    const head = argumentPrefix.slice(0, argumentPrefix.length - typed.length);
    const names = presetNames(loaded ?? builtinCatalog());
    const items = names
      .filter((name) => name.startsWith(typed))
      .map((name) => ({ value: `${head}${name}`, label: name }));
    return items.length > 0 ? items : null;
  };

  // Advisory preflight warnings are shown once per session.
  const warned = new Set<string>();

  // Verifies role models against pi's registry before spending tokens.
  // Returns the error list; empty means go.
  const preflight = (
    ctx: ExtensionContext,
    label: 'ralplan' | 'ralph',
    roles: Parameters<typeof preflightModels>[0],
    independent: [string, string],
  ): string[] => {
    const { errors, warnings } = preflightModels(
      roles,
      ctx.modelRegistry,
      independent,
    );
    for (const warning of warnings) {
      if (warned.has(warning)) continue;
      warned.add(warning);
      ctx.ui.notify(`[${label}] ${warning}`, 'warning');
    }
    return errors;
  };

  const startRun = (parent: AbortSignal | undefined): AbortController => {
    const controller = new AbortController();
    parent?.addEventListener('abort', () => controller.abort(), {
      once: true,
    });
    running.add(controller);
    return controller;
  };

  const load = (ctx: {
    cwd: string;
    isProjectTrusted(): boolean;
  }): LoadedConfig =>
    loadConfig(ctx.cwd, {
      configDirName: CONFIG_DIR_NAME,
      agentDir: getAgentDir(),
      projectTrusted: ctx.isProjectTrusted(),
    });

  const reportIssues = (ctx: ExtensionContext, cfg: LoadedConfig): void => {
    for (const issue of cfg.issues) {
      ctx.ui.notify(
        `[spiral] config ${issue.path}: ${issue.message}`,
        'warning',
      );
    }
  };

  // Fail-closed: with an invalid config the loop does not start; the user
  // must fix the file (or confirm running on defaults).
  const configFor = async (
    ctx: ExtensionCommandContext,
    allowConfirm: boolean,
  ): Promise<LoadedConfig | null> => {
    loaded = load(ctx);
    if (!loaded.fallback) return loaded;
    reportIssues(ctx, loaded);
    if (!allowConfirm) return null;
    const ok = await ctx.ui.confirm(
      'Spiral config is invalid',
      'Run ralplan with built-in defaults instead?',
    );
    return ok ? loaded : null;
  };

  pi.on('session_start', (_event, ctx) => {
    runsView?.dispose();
    runsView = mountRunsView(ctx);
    sessionPreset = undefined;
    loaded = load(ctx);
    reportIssues(ctx, loaded);
  });

  pi.on('session_shutdown', () => {
    runsView?.dispose();
    runsView = undefined;
  });

  registerAgentsCommand(pi);

  pi.registerCommand('ralplan', {
    description:
      'Consensus planning: planner -> architect -> critic loop, writes a ' +
      'plan artifact',
    getArgumentCompletions: completePreset,
    handler: async (args, ctx) => {
      const parsed = parseRalplanArgs(args);
      if (parsed.errors.length > 0 || parsed.task === '') {
        for (const error of parsed.errors) ctx.ui.notify(error, 'error');
        ctx.ui.notify(USAGE, 'error');
        return;
      }
      const cfg = await configFor(ctx, true);
      if (!cfg) {
        ctx.ui.notify('[ralplan] not started: fix spiral.json first', 'error');
        return;
      }
      const effective = resolveFor(cfg, parsed.preset);
      if (effective.error) {
        ctx.ui.notify(`[ralplan] not started: ${effective.error}`, 'error');
        return;
      }
      const errors = preflight(
        ctx,
        'ralplan',
        applyModelOverrides(effective.config.ralplan, parsed.models).roles,
        ['planner', 'critic'],
      );
      if (errors.length > 0) {
        for (const error of errors) {
          ctx.ui.notify(`[ralplan] ${error}`, 'error');
        }
        ctx.ui.notify('[ralplan] not started: fix role models first', 'error');
        return;
      }
      ctx.ui.notify(
        `[ralplan] planning${presetLabel(effective)}: ${parsed.task} ` +
          '(stop with /ralplan-cancel)',
        'info',
      );
      const controller = startRun(ctx.signal);
      let result: RalplanResult;
      try {
        result = await runRalplan({
          parent: parentOf(ctx),
          permissionAsks: effective.config.permissionAsks,
          config: effective.config.ralplan,
          cwd: ctx.cwd,
          task: parsed.task,
          deliberate: parsed.deliberate,
          interactive: parsed.interactive,
          models: parsed.models,
          onCheckpoint: parsed.interactive
            ? makeCheckpointHandler(pi, ctx)
            : undefined,
          signal: controller.signal,
          onProgress: (progress) => {
            const text = formatProgress(progress);
            if (!persistFinished(progress, text)) ctx.ui.notify(text, 'info');
          },
        });
      } finally {
        running.delete(controller);
      }
      ctx.ui.notify(summarize(result), isSuccess(result) ? 'info' : 'error');
      pi.sendMessage(
        {
          customType: 'spiral-ralplan',
          content: summarize(result),
          display: true,
          details: {
            outcome: result.outcome,
            artifactPath: result.artifactPath,
          },
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerTool({
    name: 'ralplan',
    label: 'Ralplan',
    description:
      'Run consensus planning (planner, architect, critic) for a task and ' +
      'write a plan artifact marked pending approval. Does not execute ' +
      'anything. Interactive checkpoints are not available from the tool; ' +
      'use /ralplan --interactive for those.',
    promptSnippet:
      'Consensus planning loop that produces a reviewed plan artifact',
    promptGuidelines: [
      'Use the ralplan tool when the user asks to plan, design, or scope ' +
        'non-trivial work before implementing, or says "ralplan".',
      'After the ralplan tool returns, read the artifact and present it; ' +
        'do not start implementation without user approval.',
    ],
    parameters: Type.Object({
      task: Type.String({ description: 'Task description to plan' }),
      deliberate: Type.Optional(
        Type.Boolean({
          description: 'Force deliberate mode (pre-mortem + expanded tests)',
        }),
      ),
      models: Type.Optional(
        Type.Object(
          {
            planner: Type.Optional(Type.String()),
            architect: Type.Optional(Type.String()),
            critic: Type.Optional(Type.String()),
          },
          { description: 'Per-role model overrides as provider/model ids' },
        ),
      ),
      preset: Type.Optional(PRESET_PARAM),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      loaded = load(ctx);
      if (loaded.fallback) {
        const issues = loaded.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ');
        return {
          content: [
            {
              type: 'text',
              text: `ralplan not started, spiral.json is invalid: ${issues}`,
            },
          ],
          details: { outcome: 'not_started' },
          isError: true,
        };
      }
      const effective = resolveFor(loaded, params.preset);
      if (effective.error) return notStarted('ralplan', effective.error);
      const errors = preflight(
        ctx,
        'ralplan',
        applyModelOverrides(effective.config.ralplan, params.models).roles,
        ['planner', 'critic'],
      );
      if (errors.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                'ralplan not started, role models unavailable: ' +
                `${errors.join('; ')}`,
            },
          ],
          details: { outcome: 'not_started' },
          isError: true,
        };
      }
      const result = await runRalplan({
        parent: parentOf(ctx),
        permissionAsks: effective.config.permissionAsks,
        config: effective.config.ralplan,
        cwd: ctx.cwd,
        task: params.task,
        deliberate: params.deliberate === true,
        models: params.models,
        signal,
        onProgress: (progress) => {
          const text = formatProgress(progress);
          persistFinished(progress, text);
          onUpdate?.({
            content: [{ type: 'text', text }],
            details: { iteration: progress.iteration, role: progress.role },
          });
        },
      });
      // pi treats a tool call as failed only when execute throws.
      if (!isSuccess(result)) throw new Error(summarize(result));
      return {
        content: [{ type: 'text', text: summarize(result) }],
        details: {
          outcome: result.outcome,
          artifactPath: result.artifactPath,
          iterations: result.iterations.length,
        },
      };
    },
  });

  pi.registerCommand('ralplan-cancel', {
    description: 'Cancel running /ralplan loops',
    handler: async (_args, ctx) => {
      if (running.size === 0) {
        ctx.ui.notify('[ralplan] nothing is running', 'info');
        return;
      }
      for (const controller of running) controller.abort();
      ctx.ui.notify(`[ralplan] cancelling ${running.size} run(s)`, 'warning');
    },
  });

  const ralphRunning = new Set<AbortController>();

  pi.registerCommand('ralph', {
    description:
      'PRD-driven persistence loop: draft stories, implement + verify ' +
      'each, independent review, deslop pass',
    getArgumentCompletions: completePreset,
    handler: async (args, ctx) => {
      const parsed = parseRalphArgs(args);
      if (parsed.errors.length > 0) {
        for (const error of parsed.errors) ctx.ui.notify(error, 'error');
        ctx.ui.notify(RALPH_USAGE, 'error');
        return;
      }
      const cfg = await configFor(ctx, true);
      if (!cfg) {
        ctx.ui.notify('[ralph] not started: fix spiral.json first', 'error');
        return;
      }
      const effective = resolveFor(cfg, parsed.preset);
      if (effective.error) {
        ctx.ui.notify(`[ralph] not started: ${effective.error}`, 'error');
        return;
      }
      const errors = preflight(
        ctx,
        'ralph',
        applyRalphModelOverrides(effective.config.ralph, parsed.models).roles,
        ['executor', 'reviewer'],
      );
      if (errors.length > 0) {
        for (const error of errors) ctx.ui.notify(`[ralph] ${error}`, 'error');
        ctx.ui.notify('[ralph] not started: fix role models first', 'error');
        return;
      }
      const tag = presetLabel(effective);
      ctx.ui.notify(
        parsed.resume
          ? `[ralph] resuming${tag} ${parsed.resume} (stop with /ralph-cancel)`
          : `[ralph] starting${tag}: ${parsed.task} (stop with /ralph-cancel)`,
        'info',
      );
      const controller = new AbortController();
      ctx.signal?.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
      ralphRunning.add(controller);
      let result: RalphResult;
      try {
        result = await runRalph({
          parent: parentOf(ctx),
          permissionAsks: effective.config.permissionAsks,
          config: effective.config.ralph,
          agentDir: getAgentDir(),
          cwd: ctx.cwd,
          task: parsed.task,
          plan: parsed.plan,
          resume: parsed.resume,
          noDeslop: parsed.noDeslop,
          reviewerAgent: parsed.reviewerAgent,
          models: parsed.models,
          onConfirmVerify: (commands) =>
            ctx.ui.confirm(
              'Ralph: run PRD-proposed regression commands?',
              'The PRD planner proposes these commands; they will run in ' +
                `${ctx.cwd} after every ` +
                `story:\n${commands.map((c) => `  ${c}`).join('\n')}\nSet ` +
                'ralph.verify in spiral.json to skip this question.',
            ),
          onConfirmDrift: (files) =>
            ctx.ui.confirm(
              'Ralph: run state was modified outside the loop',
              `${files.join(', ')} no longer match integrity.json. Resume ` +
                'with the files as they are?',
            ),
          signal: controller.signal,
          onProgress: (progress) => {
            const text = formatRalphProgress(progress);
            if (!persistFinished(progress, text)) ctx.ui.notify(text, 'info');
          },
        });
      } finally {
        ralphRunning.delete(controller);
      }
      const summary = summarizeRalph(result);
      ctx.ui.notify(summary, result.outcome === 'completed' ? 'info' : 'error');
      pi.sendMessage(
        {
          customType: 'spiral-ralph',
          content: summary,
          display: true,
          details: {
            outcome: result.outcome,
            runId: result.runId,
            runDir: result.runDir,
            changedFiles: result.changedFiles,
          },
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand('ralph-cancel', {
    description: 'Cancel running /ralph loops',
    handler: async (_args, ctx) => {
      if (ralphRunning.size === 0) {
        ctx.ui.notify('[ralph] nothing is running', 'info');
        return;
      }
      for (const controller of ralphRunning) controller.abort();
      ctx.ui.notify(
        `[ralph] cancelling ${ralphRunning.size} run(s)`,
        'warning',
      );
    },
  });

  pi.registerTool({
    name: 'ralph',
    label: 'Ralph',
    description:
      'Run the ralph persistence loop: draft a PRD of user stories with ' +
      'testable acceptance criteria (optionally from a ralplan artifact), ' +
      'implement and verify each story with an executor child, get an ' +
      'independent reviewer verdict, then a bounded deslop pass and ' +
      'regression re-run. Writes code in the working tree, never commits. ' +
      'State in .spiral/ralph/<runId>/.',
    promptSnippet:
      'PRD-driven implementation loop with executor, reviewer and deslop pass',
    promptGuidelines: [
      'Use the ralph tool when the user asks to implement an approved plan ' +
        'end to end, says "ralph", or wants guaranteed completion with ' +
        'verification.',
      'Prefer passing the ralplan artifact path as `plan` when one exists.',
      'After the ralph tool returns, report the outcome and the changed ' +
        'files; do not commit unless the user asks.',
    ],
    parameters: Type.Object({
      task: Type.String({ description: 'Task description to implement' }),
      plan: Type.Optional(
        Type.String({
          description: 'Path to a ralplan artifact to derive stories from',
        }),
      ),
      noDeslop: Type.Optional(
        Type.Boolean({ description: 'Skip the post-review cleanup pass' }),
      ),
      reviewerAgent: Type.Optional(
        Type.Union([Type.Literal('critic'), Type.Literal('architect')], {
          description: 'Which agent verifies completion',
        }),
      ),
      models: Type.Optional(
        Type.Object(
          {
            prd: Type.Optional(Type.String()),
            executor: Type.Optional(Type.String()),
            reviewer: Type.Optional(Type.String()),
            cleaner: Type.Optional(Type.String()),
          },
          { description: 'Per-role model overrides as provider/model ids' },
        ),
      ),
      preset: Type.Optional(PRESET_PARAM),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      loaded = load(ctx);
      if (loaded.fallback) {
        const issues = loaded.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ');
        return {
          content: [
            {
              type: 'text',
              text: `ralph not started, spiral.json is invalid: ${issues}`,
            },
          ],
          details: { outcome: 'not_started' },
          isError: true,
        };
      }
      const effective = resolveFor(loaded, params.preset);
      if (effective.error) return notStarted('ralph', effective.error);
      const errors = preflight(
        ctx,
        'ralph',
        applyRalphModelOverrides(effective.config.ralph, params.models).roles,
        ['executor', 'reviewer'],
      );
      if (errors.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                'ralph not started, role models unavailable: ' +
                `${errors.join('; ')}`,
            },
          ],
          details: { outcome: 'not_started' },
          isError: true,
        };
      }
      const result = await runRalph({
        parent: parentOf(ctx),
        permissionAsks: effective.config.permissionAsks,
        config: effective.config.ralph,
        agentDir: getAgentDir(),
        cwd: ctx.cwd,
        task: params.task,
        plan: params.plan,
        noDeslop: params.noDeslop === true,
        reviewerAgent: params.reviewerAgent,
        models: params.models,
        signal,
        onProgress: (progress) => {
          const text = formatRalphProgress(progress);
          persistFinished(progress, text);
          onUpdate?.({
            content: [{ type: 'text', text }],
            details: { iteration: progress.iteration, role: progress.role },
          });
        },
      });
      // pi treats a tool call as failed only when execute throws.
      if (result.outcome !== 'completed') {
        throw new Error(summarizeRalph(result));
      }
      return {
        content: [{ type: 'text', text: summarizeRalph(result) }],
        details: {
          outcome: result.outcome,
          runId: result.runId,
          runDir: result.runDir,
          changedFiles: result.changedFiles,
        },
      };
    },
  });

  pi.registerCommand('spiral-preset', {
    description:
      'Set the session preset for /ralplan and /ralph ("default" clears it)',
    getArgumentCompletions: (prefix) => {
      const items = presetNames(loaded ?? builtinCatalog())
        .filter((name) => name.startsWith(prefix.trim()))
        .map((name) => ({ value: name, label: name }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      loaded = load(ctx);
      const names = presetNames(loaded);
      let name = args.trim();
      if (name === '') {
        const current = sessionPreset ?? DEFAULT_PRESET;
        const options = new Map<string, string>();
        for (const candidate of names) {
          const source =
            candidate === DEFAULT_PRESET
              ? 'base config'
              : loaded.presetSources[candidate];
          const mark = candidate === current ? ' [current]' : '';
          options.set(`${candidate} (${source})${mark}`, candidate);
        }
        const choice = await ctx.ui.select('Spiral preset', [
          ...options.keys(),
        ]);
        const picked = choice === undefined ? undefined : options.get(choice);
        if (picked === undefined) return;
        name = picked;
      }
      if (!names.includes(name)) {
        ctx.ui.notify(
          `[spiral] unknown preset "${name}"; available: ${names.join(', ')}`,
          'error',
        );
        return;
      }
      sessionPreset = name === DEFAULT_PRESET ? undefined : name;
      const fallback = loaded.defaultPreset
        ? `defaultPreset ${loaded.defaultPreset} applies`
        : 'base config';
      ctx.ui.notify(
        sessionPreset
          ? `[spiral] session preset: ${sessionPreset}`
          : `[spiral] session preset cleared (${fallback})`,
        'info',
      );
    },
  });

  pi.registerCommand('spiral-config', {
    description: 'Show the effective Spiral configuration and its sources',
    handler: async (_args, ctx) => {
      loaded = load(ctx);
      const effective = resolveFor(loaded);
      const available = presetNames(loaded)
        .map((name) => `${name} (${loaded?.presetSources[name] ?? 'base'})`)
        .join(', ');
      const text = [
        'sources: ' +
          `${
            loaded.sources.length > 0
              ? loaded.sources.join(', ')
              : 'defaults only'
          }`,
        `project trusted: ${ctx.isProjectTrusted()}`,
        loaded.fallback
          ? 'EFFECTIVE: built-in defaults (config invalid)'
          : 'EFFECTIVE: merged config',
        `active preset: ${effective.preset ?? DEFAULT_PRESET}`,
        `defaultPreset: ${loaded.defaultPreset ?? 'none'}`,
        `available presets: ${available}`,
        'effective config (after active preset):',
        JSON.stringify(effective.config, null, 2),
        ...loaded.issues.map(
          (issue) => `issue: ${issue.path}: ${issue.message}`,
        ),
      ].join('\n');
      pi.sendMessage(
        { customType: 'spiral-config', content: text, display: true },
        { triggerTurn: false },
      );
    },
  });
}
