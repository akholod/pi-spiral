import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatCriticReview } from './prompts.ts';
import type { RalplanResult, RalplanRequest, UsageTotals } from './types.ts';

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'plan';

const timestamp = (): string =>
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);

// `<ISO ms>-<runId prefix>-<slug>.md`: the run id keeps concurrent runs
// with the same task in the same millisecond unique.
export const buildArtifactPath = (
  cwd: string,
  plansDir: string,
  task: string,
  runId: string,
): string =>
  join(
    cwd,
    plansDir,
    `${timestamp()}-${runId.slice(0, 8)}-${slugify(task)}.md`,
  );

// Frontmatter `status` is a bare token so the YAML stays valid and greppable;
// details go to `note`.
const STATUS: Record<RalplanResult['outcome'], string> = {
  approved: 'pending-approval',
  exhausted: 'pending-approval-unreviewed',
  rejected: 'rejected',
  aborted: 'incomplete',
  failed: 'incomplete',
};

const yamlString = (text: string): string => JSON.stringify(text);

const noteLine = (result: RalplanResult): string => {
  const rounds = result.iterations.length;
  if (result.outcome === 'exhausted') {
    return (
      result.note ??
      `critic did not approve after ${rounds} iteration(s); latest version`
    );
  }
  if (result.outcome === 'aborted')
    return 'cancelled; latest draft, not reviewed';
  if (result.outcome === 'failed') {
    return `loop failed after ${rounds} completed iteration(s): ${result.error ?? 'unknown'}; latest draft may be unreviewed`;
  }
  return 'reviewed by architect and critic; awaiting user approval';
};

export const renderArtifact = (
  request: RalplanRequest,
  result: RalplanResult,
): string => {
  const history = result.iterations.map((record) =>
    [
      `### Iteration ${record.iteration}`,
      '',
      `Critic verdict: **${record.criticReview.verdict}** — ${record.criticReview.summary}`,
      '',
      '<details><summary>Architect review</summary>',
      '',
      record.architectReview,
      '',
      '</details>',
      '',
      '<details><summary>Critic review</summary>',
      '',
      formatCriticReview(record.criticReview),
      '',
      '</details>',
      '',
    ].join('\n'),
  );

  return [
    '---',
    `status: ${STATUS[result.outcome]}`,
    `outcome: ${result.outcome}`,
    `note: ${yamlString(noteLine(result))}`,
    `mode: ${request.mode}`,
    `run: ${request.runId}`,
    `cost_usd: ${result.usage.cost.toFixed(4)}`,
    `tokens_in: ${result.usage.input}`,
    `tokens_out: ${result.usage.output}`,
    `iterations: ${result.iterations.length}`,
    `generated: ${new Date().toISOString()}`,
    'generator: pi-spiral ralplan',
    '---',
    '',
    `# Plan: ${request.task}`,
    '',
    result.finalPlan,
    '',
    '---',
    '',
    '## Review history',
    '',
    ...history,
    '## Usage',
    '',
    formatUsage(result.usage),
  ].join('\n');
};

export const formatUsage = (usage: UsageTotals): string =>
  `${usage.runs} child run(s), ${usage.turns} turns, ${usage.toolCalls} tool calls, ` +
  `${usage.input} in / ${usage.output} out tokens (cache ${usage.cacheRead} read), ` +
  `$${usage.cost.toFixed(4)}, ${Math.round(usage.durationMs / 1000)}s`;

// Exclusive create: never overwrite an existing plan.
export const writeArtifact = (path: string, content: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
};
