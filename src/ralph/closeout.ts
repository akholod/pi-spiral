// Terminal closeout of a ralph run (oh-my-claudecode ralph skill: terminal
// closeout, terminal incident work item). Pure line builders plus one
// append helper; no model call.
//
// Deviation from OMC, deliberate: the notes live in the PROJECT state dir
// (`<stateDir>/<projectKey>/notes/{problems,issues}.md`, shared by all runs
// of the project, append-only), not in the working tree. That keeps the
// working tree to the task's changes; the cleanup scope check and the git
// delta never see these files.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Prd } from './prd.ts';
import type { RunState } from './state.ts';
import type { RalphOutcome } from './types.ts';

export const MAX_CLOSEOUT_LINES = 3;
export const PROBLEMS_FILE = 'problems.md';
export const ISSUES_FILE = 'issues.md';

const SENTENCE = 200;
const SIGNATURE = 160;
const BLOCKER = 300;
const PREEXISTING = 120;

export interface CloseoutInput {
  outcome: RalphOutcome;
  runId: string;
  runDir: string;
  prd: Prd;
  state: RunState;
  error?: string;
  // set when the run stopped at the token budget
  budget?: { spent: number; limit: number };
  // regression commands that failed in the last verification run
  failingCommands?: string[];
  now?: Date;
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

const prefix = (input: CloseoutInput, label: string, sep = ': '): string =>
  `- ${(input.now ?? new Date()).toISOString().slice(0, 10)} ` +
  `${input.runId.slice(0, 8)} ${label}${sep}`;

const reopen = (input: CloseoutInput): string =>
  `reopen: /ralph --resume ${input.runId}`;

// The story entry a blocked/failed run stopped on.
const lastStoryEntry = (state: RunState) =>
  [...state.entries]
    .reverse()
    .find(
      (e) =>
        (e.outcome === 'blocked' || e.outcome === 'failed') &&
        !['review', 'deslop', 'baseline'].includes(e.storyId),
    );

// At most three factual lines for problems.md; empty when nothing applies.
export const closeoutLines = (input: CloseoutInput): string[] => {
  const { state, outcome } = input;
  const head = prefix(input, outcome);
  const lines: string[] = [];
  if (input.budget) {
    lines.push(
      `${head}stopped by token budget: ${input.budget.spent}/` +
        `${input.budget.limit} tokens`,
    );
  }
  if (outcome === 'blocked' && state.blockers) {
    const entry = lastStoryEntry(state);
    const where = entry
      ? `${entry.storyId} after ${entry.attempt} attempt(s): `
      : '';
    lines.push(`${head}${where}${oneLine(state.blockers, SENTENCE)}`);
  } else if (outcome === 'failed' && input.error) {
    lines.push(`${head}${oneLine(input.error, SENTENCE)}`);
  }
  const rejected = state.reviews.filter((r) => r.verdict === 'REJECT');
  if (rejected.length > 0) {
    lines.push(
      `${head}reviewer rejected ${rejected.length} time(s); last: ${oneLine(
        rejected[rejected.length - 1].summary,
        SENTENCE,
      )}`,
    );
  }
  const retried = input.prd.userStories.filter((s) => s.attempts > 1);
  if (retried.length > 0) {
    lines.push(
      `${head}retries: ${retried
        .map((s) => `${s.id} x${s.attempts}`)
        .join(', ')}`,
    );
  }
  if (state.verification === 'none' && state.iterations > 0) {
    lines.push(
      `${head}no regression commands ran; only executor and reviewer evidence`,
    );
  }
  if (state.baselineWarnings.length > 0) {
    lines.push(
      `${head}pre-existing failures left untouched: ` +
        `${state.baselineWarnings.length} (first: ` +
        `${oneLine(state.baselineWarnings[0], PREEXISTING)})`,
    );
  }
  return lines.slice(0, MAX_CLOSEOUT_LINES);
};

// Stop-and-report halts get an incident item in issues.md: the three-strike
// rule, or regression commands that cannot pass after cleanup.
export const incidentLine = (input: CloseoutInput): string | null => {
  const { state } = input;
  let signature: string;
  if (input.outcome === 'blocked' && state.haltKind === 'three-strike') {
    signature = state.blockers ?? 'story failed repeatedly';
  } else if (input.outcome === 'failed' && state.haltKind === 'verify') {
    signature = input.error ?? 'regression commands cannot pass';
  } else {
    return null;
  }
  const evidence = [`${input.runDir}/run.json`, `${input.runDir}/progress.md`];
  const failing = input.failingCommands ?? [];
  if (failing.length > 0) evidence.push(`last verify: ${failing.join(', ')}`);
  return (
    `${prefix(input, 'INCIDENT', ' ')}${oneLine(signature, SIGNATURE)} | ` +
    `evidence: ${evidence.join(', ')} | ${reopen(input)}`
  );
};

// A blocked run waiting for the user (the incident line covers the rest).
export const blockerLine = (input: CloseoutInput): string | null =>
  input.outcome === 'blocked' &&
  input.state.haltKind === 'user-input' &&
  input.state.blockers
    ? `${prefix(input, 'blocked')}${oneLine(input.state.blockers, BLOCKER)} ` +
      `| ${reopen(input)}`
    : null;

export interface CloseoutNotes {
  problems: string[];
  issues: string[];
}

export const closeoutNotes = (input: CloseoutInput): CloseoutNotes => {
  const issue = incidentLine(input) ?? blockerLine(input);
  return { problems: closeoutLines(input), issues: issue ? [issue] : [] };
};

// Append only; a file is touched only when it has lines to add.
export const appendNotes = (
  projectDir: string,
  notes: CloseoutNotes,
): { problems: number; issues: number; dir: string } => {
  const dir = join(projectDir, 'notes');
  const append = (file: string, lines: string[]): void => {
    if (lines.length === 0) return;
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), `${lines.join('\n')}\n`, 'utf8');
  };
  append(PROBLEMS_FILE, notes.problems);
  append(ISSUES_FILE, notes.issues);
  return {
    problems: notes.problems.length,
    issues: notes.issues.length,
    dir,
  };
};
