// Spiral: ralplan + ralph for pi.
//
// Entry point. Responsibilities:
//   - load and validate spiral.json (user + project), fail-closed
//   - register role agents with pi-subagents (runtime registration)
//   - expose `/ralplan` (slash command) and `ralplan` (LLM tool)
//   - `/ralph` placeholder until phase 2

import { Type } from 'typebox';
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { loadConfig, type LoadedConfig } from '../src/config.ts';
import {
  registerRoleAgents,
  type Disposable,
} from '../src/subagents/register-agents.ts';
import { parseRalplanArgs, runRalplan } from '../src/ralplan/index.ts';
import { formatUsage } from '../src/ralplan/artifact.ts';
import type { LoopProgress } from '../src/ralplan/loop.ts';
import type {
  CheckpointDecision,
  CheckpointHandler,
  RalplanResult,
} from '../src/ralplan/types.ts';
import { describeRalph } from '../src/ralph/index.ts';

const formatProgress = (progress: LoopProgress): string =>
  `[ralplan] iteration ${progress.iteration}: ${progress.role} ${progress.phase}` +
  (progress.detail ? ` (${progress.detail})` : '');

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
        `ralplan NOT approved: critic verdict ${verdict} after ${rounds} iteration(s) (limit reached).`,
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
        `ralplan FAILED after ${rounds} completed iteration(s): ${result.error}`,
      );
      break;
  }
  if (result.artifactPath) lines.push(`artifact: ${result.artifactPath}`);
  else if (result.outcome !== 'rejected') lines.push('artifact: none written');
  lines.push(`usage: ${formatUsage(result.usage)}`);
  return lines.join('\n');
};

const USAGE =
  'Usage: /ralplan [--deliberate] [--interactive] [--planner m] [--architect m] [--critic m] <task>';

const DRAFT_OPTIONS = ['Proceed to review', 'Request changes', 'Skip review'];
const FINAL_OPTIONS = ['Approve', 'Request changes', 'Reject'];

const makeCheckpointHandler =
  (ctx: ExtensionCommandContext): CheckpointHandler =>
  async (checkpoint, plan): Promise<CheckpointDecision> => {
    const title =
      checkpoint === 'draft'
        ? 'Ralplan: initial draft'
        : 'Ralplan: critic approved';
    // Show the plan before asking; the dialog itself has no room for it.
    ctx.ui.notify(plan.slice(0, 4000), 'info');
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
    if (choice === 'Reject' || choice === undefined)
      return { action: 'reject' };
    return { action: 'proceed' };
  };

export default function spiralExtension(pi: ExtensionAPI) {
  let loaded: LoadedConfig | null = null;
  let agents: Disposable | null = null;

  const load = (ctx: {
    cwd: string;
    isProjectTrusted(): boolean;
  }): LoadedConfig =>
    loadConfig(ctx.cwd, {
      configDirName: CONFIG_DIR_NAME,
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
    loaded = load(ctx);
    reportIssues(ctx, loaded);
    agents?.dispose();
    agents = null;
    try {
      agents = registerRoleAgents(pi);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`[spiral] agents not registered: ${message}`, 'warning');
    }
  });

  pi.on('session_shutdown', () => {
    agents?.dispose();
    agents = null;
  });

  pi.registerCommand('ralplan', {
    description:
      'Consensus planning: planner -> architect -> critic loop, writes a plan artifact',
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
      ctx.ui.notify(`[ralplan] planning: ${parsed.task}`, 'info');
      const result = await runRalplan({
        pi,
        config: cfg.config.ralplan,
        cwd: ctx.cwd,
        task: parsed.task,
        deliberate: parsed.deliberate,
        interactive: parsed.interactive,
        models: parsed.models,
        onCheckpoint: parsed.interactive
          ? makeCheckpointHandler(ctx)
          : undefined,
        signal: ctx.signal,
        onProgress: (progress) =>
          ctx.ui.notify(formatProgress(progress), 'info'),
      });
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
      'Run consensus planning (planner, architect, critic) for a task and write a plan artifact marked pending approval. Does not execute anything. Interactive checkpoints are not available from the tool; use /ralplan --interactive for those.',
    promptSnippet:
      'Consensus planning loop that produces a reviewed plan artifact',
    promptGuidelines: [
      'Use the ralplan tool when the user asks to plan, design, or scope non-trivial work before implementing, or says "ralplan".',
      'After the ralplan tool returns, read the artifact and present it; do not start implementation without user approval.',
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
      const result = await runRalplan({
        pi,
        config: loaded.config.ralplan,
        cwd: ctx.cwd,
        task: params.task,
        deliberate: params.deliberate === true,
        models: params.models,
        signal,
        onProgress: (progress) =>
          onUpdate?.({
            content: [{ type: 'text', text: formatProgress(progress) }],
            details: { iteration: progress.iteration, role: progress.role },
          }),
      });
      return {
        content: [{ type: 'text', text: summarize(result) }],
        details: {
          outcome: result.outcome,
          artifactPath: result.artifactPath,
          iterations: result.iterations.length,
        },
        isError: !isSuccess(result),
      };
    },
  });

  pi.registerCommand('ralph', {
    description: 'PRD-driven execution loop (phase 2, not implemented yet)',
    handler: async (_args, ctx) => {
      const cfg = load(ctx);
      ctx.ui.notify(describeRalph(cfg.config.ralph), 'info');
    },
  });

  pi.registerCommand('spiral-config', {
    description: 'Show the effective Spiral configuration and its sources',
    handler: async (_args, ctx) => {
      loaded = load(ctx);
      const text = [
        `sources: ${loaded.sources.length > 0 ? loaded.sources.join(', ') : 'defaults only'}`,
        `project trusted: ${ctx.isProjectTrusted()}`,
        loaded.fallback
          ? 'EFFECTIVE: built-in defaults (config invalid)'
          : 'EFFECTIVE: merged config',
        JSON.stringify(loaded.config, null, 2),
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
