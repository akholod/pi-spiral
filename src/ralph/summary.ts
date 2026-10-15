// Pure builders for the short digests shown in the main session when a
// ralph role finishes ("what did the role conclude"). No I/O.

import { clip, SUMMARY_LINE_MAX } from '../ralplan/summary.ts';
import type { ReviewReport } from './types.ts';

const MAX_LINES = 3;
const MAX_NAMED_FILES = 3;

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`;

// Greedily joins items with ", " after `prefix` while the line fits.
const pack = (
  items: string[],
  prefix: string,
): { line: string; used: number } => {
  let line = prefix;
  let used = 0;
  for (const item of items) {
    const next =
      line === '' ? item : `${line}${used === 0 ? ' ' : ', '}${item}`;
    if (next.length > SUMMARY_LINE_MAX && used > 0) break;
    line = next;
    used++;
  }
  return { line: clip(line), used };
};

// `N stories:` followed by "ID title" items, packed into at most two lines.
export const prdSummary = (
  stories: { id: string; title: string }[],
): string[] => {
  const noun = stories.length === 1 ? 'story' : 'stories';
  const header = `${stories.length} ${noun}`;
  if (stories.length === 0) return [header];
  const items = stories.map((s) => `${s.id} ${clip(s.title, 40)}`);
  const first = pack(items, `${header}:`);
  const rest = items.slice(first.used);
  if (rest.length === 0) return [first.line];
  const second = pack(rest, '');
  const left = rest.length - second.used;
  return [
    first.line,
    left > 0 ? clip(`${second.line}, (+${left} more)`) : second.line,
  ];
};

export const storyLabel = (story: { id: string; title: string }): string =>
  clip(`${story.id} ${story.title}`, 80);

const filesLine = (files: string[]): string => {
  if (files.length === 0) return 'no files changed';
  const names = files.slice(0, MAX_NAMED_FILES).join(', ');
  const more = files.length > MAX_NAMED_FILES ? ', …' : '';
  return clip(`${plural(files.length, 'file')} changed: ${names}${more}`);
};

export type ExecutorOutcome = 'pass' | 'retry' | 'blocked';

export interface ExecutorDigest {
  storyId?: string;
  outcome: ExecutorOutcome;
  attempt: number;
  maxAttempts: number;
  // the executor's own one-paragraph report summary
  report: string;
  filesChanged: string[];
  // first reason the attempt did not pass
  problem?: string;
}

export const executorSummary = (digest: ExecutorDigest): string[] => {
  const id = digest.storyId ? `${digest.storyId} ` : '';
  let head = `${id}pass`;
  if (digest.outcome === 'retry') {
    head = `${id}retry ${digest.attempt}/${digest.maxAttempts}`;
  } else if (digest.outcome === 'blocked') {
    head = `${id}blocked`;
  }
  if (digest.problem) head += `: ${digest.problem}`;
  const lines = [clip(head)];
  if (digest.report.trim() !== '') lines.push(clip(digest.report));
  lines.push(filesLine(digest.filesChanged));
  return lines.slice(0, MAX_LINES);
};

export interface VerifyDigest {
  newFailures: string[];
  baselineFailures: string[];
}

export const verifySummary = (digest: VerifyDigest): string[] => {
  const { newFailures, baselineFailures } = digest;
  const lines = [
    newFailures.length === 0
      ? 'no new failures'
      : clip(`${plural(newFailures.length, 'new failure')}: ${newFailures[0]}`),
  ];
  if (baselineFailures.length > 0) {
    lines.push(
      `warning: ${plural(baselineFailures.length, 'pre-existing failure')} ` +
        'still present',
    );
  }
  return lines;
};

// The pre-run baseline recording.
export const baselineSummary = (known: string[]): string[] =>
  known.length === 0
    ? ['baseline clean']
    : [
        clip(
          `baseline: ${plural(known.length, 'pre-existing failure')}, ` +
            `e.g. ${known[0]}`,
        ),
      ];

const BLOCKING = new Set(['CRITICAL', 'MAJOR']);
const DOWNGRADE = /\[verdict downgraded from APPROVE: ([^\]]*)\]/;

export interface ReviewerDigest {
  report: ReviewReport;
  // stories the rejection re-opened (including the added review story)
  reopened: string[];
  // ids among `reopened` that did not exist before this review
  added: string[];
}

export const reviewerSummary = (digest: ReviewerDigest): string[] => {
  const { report, reopened, added } = digest;
  if (report.verdict === 'APPROVE') {
    return [clip(`APPROVE — ${report.summary}`)];
  }
  const existing = reopened.filter((id) => !added.includes(id));
  const parts: string[] = [];
  if (existing.length > 0) parts.push(`reopened ${existing.join(', ')}`);
  if (added.length > 0) parts.push(`added ${added.join(', ')}`);
  const lines = [clip(`REJECT — ${parts.join('; ') || 'no story changes'}`)];
  const downgrade = DOWNGRADE.exec(report.summary);
  if (downgrade) {
    lines.push(clip(`APPROVE downgraded to REJECT: ${downgrade[1]}`));
  }
  const blocking = report.findings.find((f) => BLOCKING.has(f.severity));
  if (blocking) {
    const where = blocking.storyId ? ` (${blocking.storyId})` : '';
    lines.push(clip(`${blocking.severity}${where}: ${blocking.title}`));
  } else if (!downgrade) {
    lines.push(clip(report.summary));
  }
  return lines.slice(0, MAX_LINES);
};

export interface CleanerDigest {
  // the cleaner's own report
  report: string;
  // files the cleanup was scoped to (the run's changed files)
  scopeFiles: number;
  // regression-fix executor runs after the cleanup (0 = none needed)
  repairs: number;
  // regression commands green after cleanup/repairs
  ok: boolean;
}

export const cleanerSummary = (digest: CleanerDigest): string[] => {
  const lines = [`cleanup scoped to ${plural(digest.scopeFiles, 'file')}`];
  const first = digest.report.split('\n').find((l) => l.trim() !== '');
  if (first) lines.push(clip(first.replace(/^[#>*\-\s]+/, '')));
  if (digest.repairs > 0) {
    const attempts = plural(digest.repairs, 'fix attempt');
    lines.push(
      digest.ok
        ? `regression repaired after ${attempts}`
        : `regression still failing after ${attempts}`,
    );
  } else if (!digest.ok) {
    lines.push('regression commands failing after cleanup');
  }
  return lines.slice(0, MAX_LINES);
};
