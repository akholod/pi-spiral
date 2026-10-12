// Feedback baseline (pure, no IO). Ported from oh-my-claudecode v5.6.2,
// src/hooks/ralph/feedback-baseline.ts (`signatureLines`,
// `diffAgainstBaseline`) and src/cli/commands/ralph.ts (`UNRUNNABLE_PATTERN`,
// `runFeedbackCommand`).
//
// Before the first story the loop records, per regression command, the
// normalized failure signature lines of the untouched tree. Every later gate
// diffs the current run against that baseline: new signatures are real
// signal, baseline-only signatures are environment noise that must not
// consume iterations.

import type { CommandResult } from './verify.ts';

/** Per-command signature cap: runaway output must not bloat run.json. */
export const MAX_SIGNATURES_PER_COMMAND = 200;

export interface CommandBaseline {
  // normalized failure signatures, sorted
  signatures: string[];
  // the command could not execute at all (tool missing, suite unrunnable)
  unrunnable?: boolean;
}

// keyed by the command string
export type FeedbackBaseline = Record<string, CommandBaseline>;

export interface BaselineDiff {
  // present now, absent in the baseline (or touching a file of this work)
  newFailures: string[];
  // present in the baseline and still present: do not block
  baselineFailures: string[];
  // in the baseline, gone now: informational only
  resolved: string[];
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex

// Volatile substrings normalized away: durations, timestamps, tmp paths,
// hex ids.
const VOLATILE_PATTERNS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds)\b/gi,
  /\bduration_ms\s*:?\s*\d+(?:\.\d+)?\b/gi,
  /\bduration\s*:?\s*\d+(?:\.\d+)?\b/gi,
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
  /[A-Za-z]:\\[^\s:]*\\[^\s]*(?:omc|omc-)[^\s\\/]+/g,
  /\/tmp\/[\w.-]+/g,
  /\b[0-9a-f]{8,}\b/gi,
];

const PROGRESS_LINE = new RegExp(
  '^(running|collecting|compiling|building|passing|tap\\s+version|✓|√|%|' +
    '\\s*at\\s)',
  'i',
);
const FAILURE_WORD = /fail|error|✗|×/i;

// DEVIATION from OMC, whose filters only know TAP: other reporters print
// passing results and counters that change as tests are added. Found live
// with node:test's spec reporter (`✔ name (12ms)`, `ℹ pass 3`).
const PASSING_LINE = /^(?:✔|PASS\s|\d+\s+passing\b)/;
const SPEC_COUNTER =
  /^ℹ\s*(?:tests|suites|pass|skipped|cancelled|todo|duration_ms)\b/i;
const SPEC_NO_FAILURES = /^ℹ\s*fail\s+0\s*$/i;
// `Tests: 1 failed, 3 passed, 4 total`: keep the failed count only.
const PASS_COUNTS = /\b\d+\s+(passed|passing|total|skipped|todo|pending)\b/gi;

// Reduces one command's combined output to its failure signature set: ANSI
// stripped, volatile fragments normalized, boilerplate dropped, deduplicated,
// capped and sorted for a stable diff. Pass/test counters, TAP plan lines and
// passing results ("ok N ...") vary as tests are added and are dropped;
// `# fail N` (N > 0) and `not ok ...` are kept.
export const signatureLines = (output: string): string[] => {
  const seen = new Set<string>();
  for (const raw of output.replace(ANSI_PATTERN, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    for (const pattern of VOLATILE_PATTERNS) {
      line = line.replace(pattern, '<v>');
    }
    line = line.replace(/\s+/g, ' ').trim();
    if (!line || line.length > 500) continue;
    // Progress chatter and test format headers carry no failure signal.
    if (PROGRESS_LINE.test(line) && !FAILURE_WORD.test(line)) continue;
    if (/^#\s*(?:pass|tests?|skipped|cancelled|todo)\s+\d+\s*$/.test(line)) {
      continue;
    }
    if (/^#\s*fail\s+0\s*$/.test(line)) continue;
    // markers or durations only (# <v>, # <v> <v>)
    if (/^#\s*<v>\s*(<v>\s*)*$/.test(line)) continue;
    // TAP plan lines (1..2)
    if (/^\d+\.\.\d+\s*$/.test(line)) continue;
    if (/^ok\s+\d+\s+/i.test(line) && !line.includes('not ok')) continue;
    if (PASSING_LINE.test(line) && !FAILURE_WORD.test(line)) continue;
    if (SPEC_COUNTER.test(line) || SPEC_NO_FAILURES.test(line)) continue;
    line = line.replace(PASS_COUNTS, '<n> $1');
    seen.add(line);
    if (seen.size >= MAX_SIGNATURES_PER_COMMAND) break;
  }
  return [...seen].sort();
};

const UNRUNNABLE_PATTERN = new RegExp(
  'not recognized as an internal or external command|command not found|' +
    'no such file or directory',
  'i',
);

const KILLED_MARKER = '[killed: timeout';

// DEVIATION from OMC: OMC fingerprints the output of any command, so new
// chatter in a passing build reads as a new failure. Here a command that
// exits 0 has no signatures; only failing commands are fingerprinted.
export const fingerprint = (result: CommandResult): CommandBaseline => {
  if (result.ok) return { signatures: [] };
  if (result.output.includes(KILLED_MARKER)) {
    return { signatures: ['<timeout>'] };
  }
  // a null exit code without a kill is a spawn error
  if (result.exitCode === null || UNRUNNABLE_PATTERN.test(result.output)) {
    return { signatures: [], unrunnable: true };
  }
  const signatures = signatureLines(result.output);
  // a failure must never be invisible
  if (signatures.length === 0) signatures.push(`<exit ${result.exitCode}>`);
  return { signatures };
};

export const fingerprintAll = (results: CommandResult[]): FeedbackBaseline =>
  Object.fromEntries(results.map((r) => [r.command, fingerprint(r)]));

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when the signature names the file: its repo-relative path, or its
// basename as a whole path segment (so `index.ts` does not match
// `xindex.ts`).
export const mentionsFile = (signature: string, file: string): boolean => {
  const path = file.replace(/^\.\//, '');
  if (path === '') return false;
  if (signature.includes(path)) return true;
  const base = path.split(/[\\/]/).pop() ?? '';
  if (base === '') return false;
  return new RegExp(
    `(?:^|[\\s/\\\\('"])${escapeRegExp(base)}(?:$|[:)\\s'",])`,
  ).test(signature);
};

// OMC diffAgainstBaseline plus the SKILL.md step 1f exception moved into
// code: a baseline failure that mentions a file this work touched is judged
// new, because the work may have changed what it means.
export const diffBaseline = (
  baseline: FeedbackBaseline | null,
  current: FeedbackBaseline,
  touched: string[],
): BaselineDiff => {
  const diff: BaselineDiff = {
    newFailures: [],
    baselineFailures: [],
    resolved: [],
  };
  for (const [command, now] of Object.entries(current)) {
    const before = baseline?.[command];
    if (!before) {
      for (const s of now.signatures) diff.newFailures.push(`${command}: ${s}`);
      if (now.unrunnable) diff.newFailures.push(`${command}: <unrunnable>`);
      continue;
    }
    if (now.unrunnable) {
      if (before.unrunnable) {
        diff.baselineFailures.push(`${command}: <unrunnable>`);
      } else {
        diff.newFailures.push(`${command}: <command became unrunnable>`);
      }
      continue;
    }
    const was = new Set(before.signatures);
    const is = new Set(now.signatures);
    for (const s of is) {
      const line = `${command}: ${s}`;
      const isNew = !was.has(s) || touched.some((f) => mentionsFile(s, f));
      (isNew ? diff.newFailures : diff.baselineFailures).push(line);
    }
    for (const s of was) {
      if (!is.has(s)) diff.resolved.push(`${command}: ${s}`);
    }
  }
  return diff;
};

// Every pre-existing failure line, for prompts and the progress summary.
export const listBaselineFailures = (
  baseline: FeedbackBaseline | null,
): string[] =>
  Object.entries(baseline ?? {}).flatMap(([command, entry]) =>
    entry.unrunnable
      ? [`${command}: <unrunnable>`]
      : entry.signatures.map((s) => `${command}: ${s}`),
  );

export const isFeedbackBaseline = (
  value: unknown,
): value is FeedbackBaseline => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      Array.isArray(e.signatures) &&
      e.signatures.every((s) => typeof s === 'string') &&
      (e.unrunnable === undefined || typeof e.unrunnable === 'boolean')
    );
  });
};
