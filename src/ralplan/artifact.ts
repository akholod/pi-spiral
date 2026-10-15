import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  if (result.outcome === 'aborted') {
    return 'cancelled; latest draft, not reviewed';
  }
  if (result.outcome === 'failed') {
    return (
      `loop failed after ${rounds} completed iteration(s): ` +
      `${result.error ?? 'unknown'}; latest draft may be unreviewed`
    );
  }
  if (rounds === 0) return 'draft accepted by user without review';
  return 'reviewed by architect and critic; awaiting user approval';
};

export const formatUsage = (usage: UsageTotals): string =>
  `${usage.runs} child run(s), ${usage.turns} turns, ${usage.toolCalls} ` +
  'tool calls, ' +
  `${usage.input} in / ${usage.output} out tokens (cache ` +
  `${usage.cacheRead} read), ` +
  `$${usage.cost.toFixed(4)}, ${Math.round(usage.durationMs / 1000)}s`;

// `<plan basename without .md>-reviews`, next to the plan file.
export const reviewsDirOf = (artifactPath: string): string =>
  `${artifactPath.replace(/\.md$/, '')}-reviews`;

export interface ReviewFile {
  name: string;
  content: string;
}

// Per-iteration planner output and both reviews, `<role>-v<N>.md`.
export const renderReviewFiles = (result: RalplanResult): ReviewFile[] =>
  result.iterations.flatMap((record) => [
    { name: `plan-v${record.iteration}.md`, content: record.plan },
    {
      name: `architect-v${record.iteration}.md`,
      content: record.architectReview,
    },
    {
      name: `critic-v${record.iteration}.md`,
      content: formatCriticReview(record.criticReview),
    },
  ]);

const consensusLine = (result: RalplanResult, reviews?: string): string => {
  const where = reviews ? `; architect and critic reviews in ${reviews}/` : '';
  const rounds = result.iterations.length;
  if (result.outcome === 'approved' && rounds > 0) {
    return `Consensus: critic APPROVE after ${rounds} iteration(s)${where}.`;
  }
  return `Not approved: ${noteLine(result)}${where}.`;
};

// The planner usually opens with its own H1; keep it as the title instead of
// stacking a second one above it.
const splitTitle = (
  task: string,
  plan: string,
): { title: string; body: string } => {
  const match = /^\s*(# [^\n]+)\n?/.exec(plan);
  if (!match) return { title: `# Plan: ${task}`, body: plan };
  return { title: match[1].trim(), body: plan.slice(match[0].length) };
};

// `reviews` is the sidecar directory name relative to the plan file's folder;
// omitted when there are no per-iteration files.
export const renderArtifact = (
  request: RalplanRequest,
  result: RalplanResult,
  reviews?: string,
): string => {
  const { title, body } = splitTitle(request.task, result.finalPlan);
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
    `usage: ${yamlString(formatUsage(result.usage))}`,
    `iterations: ${result.iterations.length}`,
    ...(reviews ? [`reviews: ${yamlString(reviews)}`] : []),
    `generated: ${new Date().toISOString()}`,
    'generator: pi-spiral ralplan',
    '---',
    '',
    title,
    '',
    consensusLine(result, reviews),
    '',
    body.replace(/^\s*\n/, ''),
    '',
  ].join('\n');
};

// Exclusive create: never overwrite an existing plan.
export const writeArtifact = (path: string, content: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
};

// Writes the main plan exclusively, then the reviews sidecar. A sidecar
// failure keeps the plan and is returned as a warning instead of thrown.
export const writeArtifacts = (
  path: string,
  request: RalplanRequest,
  result: RalplanResult,
): { warning?: string } => {
  const files = renderReviewFiles(result);
  const dir = reviewsDirOf(path);
  writeArtifact(
    path,
    renderArtifact(
      request,
      result,
      files.length > 0 ? basename(dir) : undefined,
    ),
  );
  if (files.length === 0) return {};
  try {
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(dir, file.name), file.content, 'utf8');
    }
    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warning: `reviews folder not fully written: ${message}` };
  }
};
