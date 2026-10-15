// Pure builders for the one-line digests shown in the main session when a
// ralplan role finishes ("what did the role conclude"). No I/O.

import type { CriticReview } from './types.ts';

export const SUMMARY_LINE_MAX = 160;

// Collapses whitespace (incl. newlines) and cuts to `max` chars with "…".
export const clip = (text: string, max = SUMMARY_LINE_MAX): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

// One header line plus the role's digest lines indented underneath; the
// shape of every progress notification.
export const withProgressSummary = (
  header: string,
  summary?: string[],
): string => [header, ...(summary ?? []).map((l) => `  ${l}`)].join('\n');

// Drops list/number markers and emphasis so a line reads as plain text.
const cleanInline = (text: string): string =>
  text
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*>\s*/, '')
    .trim();

// Persistent transcript entry for a finished role (not sent to the model).
export const PROGRESS_ENTRY_TYPE = 'spiral-progress';

export type ProgressLevel = 'info' | 'warning' | 'error';

export interface ProgressEntryData {
  // header line, then the indented digest lines
  text: string;
  level: ProgressLevel;
}

// Role statuses / verification states that are not a problem.
const OK_DETAILS = new Set(['completed', 'passed', 'baseline', 'none']);

export const progressEntry = (
  text: string,
  detail?: string,
): ProgressEntryData => ({
  text,
  level: detail === undefined || OK_DETAILS.has(detail) ? 'info' : 'error',
});

// Colors the header line; digest lines stay in the normal text color.
export const renderProgressText = (
  data: ProgressEntryData,
  fg: (color: 'muted' | 'warning' | 'error', text: string) => string,
): string => {
  const [header, ...rest] = data.text.split('\n');
  const color = data.level === 'info' ? 'muted' : data.level;
  return [fg(color, header), ...rest].join('\n');
};

interface Heading {
  level: number;
  text: string;
}

// "## Title" or a whole-line "**Title**" (the planner uses either).
const headingOf = (line: string): Heading | null => {
  const hash = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (hash) return { level: hash[1].length, text: cleanInline(hash[2]) };
  const bold = /^\s*(?:\d+[.)]\s*)?\*\*(.+?)\*\*[\s:.-]*$/.exec(line);
  if (bold) return { level: 6, text: cleanInline(bold[1]) };
  return null;
};

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_]\s*){3,}$/;
const TABLE_ROW = /^\s*\|/;

// Non-heading, non-fence, non-rule, non-table lines with their cleaned text.
// Lines inside code fences are skipped.
const proseLines = (text: string): string[] => {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.trim() === '') continue;
    if (headingOf(line) || RULE.test(line) || TABLE_ROW.test(line)) continue;
    const cleaned = cleanInline(line);
    if (cleaned !== '') out.push(cleaned);
  }
  return out;
};

// Lines of the section under the first heading matching `title`, up to the
// next heading of the same or a higher level.
const sectionLines = (text: string, title: RegExp): string[] | null => {
  const lines = text.split('\n');
  let start = -1;
  let level = 0;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const heading = headingOf(lines[i]);
    if (start < 0) {
      if (heading && title.test(heading.text)) {
        start = i + 1;
        level = heading.level;
      }
    } else if (heading && heading.level <= level) {
      return lines.slice(start, i);
    }
  }
  return start < 0 ? null : lines.slice(start);
};

export const planHeadline = (plan: string): string => {
  let fenced = false;
  for (const line of plan.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = headingOf(line);
    if (heading && heading.text !== '') return heading.text;
  }
  return proseLines(plan)[0] ?? '';
};

const STEPS_TITLE = /\b(implementation|steps?)\b/i;
const CHANGELOG_TITLE = /change\s?log|what changed|revision notes/i;

// Number of top-level items in the "Implementation steps" section, or null
// when the plan has no such section.
export const countSteps = (plan: string): number | null => {
  const section = sectionLines(plan, STEPS_TITLE);
  if (!section) return null;
  const items = section.filter((line) => /^(\d+[.)]|[-*+])\s+\S/.test(line));
  return items.length > 0 ? items.length : null;
};

// First item (or first line) of the plan's Changelog section.
export const changelogItem = (plan: string): string | null => {
  const section = sectionLines(plan, CHANGELOG_TITLE);
  if (!section) return null;
  const first = proseLines(section.join('\n'))[0];
  return first ?? null;
};

export const plannerSummary = (plan: string, iteration: number): string[] => {
  const lines: string[] = [];
  const steps = countSteps(plan);
  const headline = planHeadline(plan);
  if (headline !== '') {
    const suffix = steps ? ` (${steps} step${steps === 1 ? '' : 's'})` : '';
    lines.push(clip(headline + suffix));
  } else if (steps) {
    lines.push(`${steps} step${steps === 1 ? '' : 's'}`);
  }
  if (iteration >= 2) {
    const change = changelogItem(plan);
    lines.push(
      clip(
        change
          ? `revised from feedback: ${change}`
          : 'revised from architect/critic feedback',
      ),
    );
  }
  return lines;
};

const ARCHITECT_FOCUS = /antithesis|steelman|trade-?off/i;
const BOILERPLATE = new RegExp(
  `^(${[
    "here('s| is| are)",
    'below is',
    "i('ve| have| will)",
    'sure',
    'certainly',
    'the following',
    'architect(ure)? review\\b',
    'review of\\b',
  ].join('|')})`,
  'i',
);

// First meaningful line of an architect review, preferring the
// antithesis / tradeoff content over the generic summary.
export const architectSummary = (review: string): string[] => {
  const focused = sectionLines(review, ARCHITECT_FOCUS);
  const fromSection = focused
    ? proseLines(focused.join('\n')).find((l) => !BOILERPLATE.test(l))
    : undefined;
  // "Consensus addendum" often lists "**Antithesis (steelman):** text" inline
  const inline = proseLines(review).find((l) => ARCHITECT_FOCUS.test(l));
  const chosen =
    fromSection ??
    inline ??
    proseLines(review).find((l) => !BOILERPLATE.test(l));
  return chosen ? [clip(chosen)] : [];
};

const BLOCKING = new Set(['CRITICAL', 'MAJOR']);
const DOWNGRADE = /\[verdict downgraded from APPROVE: ([^\]]*)\]/;

// `VERDICT — N CRITICAL, M MAJOR, K MINOR`, a downgrade note, and the top
// blocking findings. Expects the review after normalizeReview.
export const criticSummary = (review: CriticReview): string[] => {
  const count = (severity: string): number =>
    review.findings.filter((f) => f.severity === severity).length;
  const lines = [
    `${review.verdict} — ${count('CRITICAL')} CRITICAL, ` +
      `${count('MAJOR')} MAJOR, ${count('MINOR')} MINOR`,
  ];
  const downgrade = DOWNGRADE.exec(review.summary);
  if (downgrade) {
    lines.push(clip(`APPROVE downgraded to ITERATE: ${downgrade[1]}`));
  }
  const rank = (severity: string): number => (severity === 'CRITICAL' ? 0 : 1);
  const top = review.findings
    .filter((f) => BLOCKING.has(f.severity))
    .sort((a, b) => rank(a.severity) - rank(b.severity))
    .slice(0, downgrade ? 1 : 2);
  for (const finding of top) {
    const text = finding.title.trim() || finding.why;
    lines.push(clip(`${finding.severity}: ${text}`));
  }
  return lines.slice(0, 3);
};
