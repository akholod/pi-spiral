// On-disk state of one ralph run: `<stateDir>/<runId>/{prd.json, run.json,
// progress.md}`. prd.json and run.json are the resumable truth; progress.md
// is rendered from run.json for humans (OMC progress.txt).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { normalizePrd, type Prd } from './prd.ts';
import type { ReviewReport } from './types.ts';

export const PRD_FILE = 'prd.json';
export const RUN_FILE = 'run.json';
export const PROGRESS_FILE = 'progress.md';

export interface ProgressEntry {
  timestamp: string;
  storyId: string;
  attempt: number;
  outcome: 'passed' | 'failed' | 'blocked' | 'cleanup' | 'regression-fix';
  summary: string;
  filesChanged: string[];
  learnings: string[];
}

export interface RunState {
  runId: string;
  task: string;
  startedAt: string;
  planArtifact?: string;
  reviewerAgent: string;
  deslop: boolean;
  iterations: number;
  reviewRounds: number;
  // files touched during this run (executor reports + git delta)
  changedFiles: string[];
  // git-dirty paths before the run; excluded from the delta
  gitBaseline: string[];
  patterns: string[];
  entries: ProgressEntry[];
  reviews: ReviewReport[];
  // why the run stopped with `blocked`, if it did
  blockers?: string;
}

export const runDirFor = (
  cwd: string,
  stateDir: string,
  runId: string,
): string => join(cwd, stateDir, runId);

const writeAtomic = (path: string, content: string): void => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
};

export const createRunDir = (runDir: string): void => {
  mkdirSync(runDir, { recursive: true });
};

export const writePrd = (runDir: string, prd: Prd): void =>
  writeAtomic(join(runDir, PRD_FILE), JSON.stringify(prd, null, 2) + '\n');

export const readPrd = (runDir: string): { prd?: Prd; error?: string } => {
  const path = join(runDir, PRD_FILE);
  try {
    const prd = normalizePrd(JSON.parse(readFileSync(path, 'utf8')));
    return prd ? { prd } : { error: `invalid PRD structure in ${path}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `cannot read ${path}: ${message}` };
  }
};

export const writeRun = (runDir: string, state: RunState): void => {
  writeAtomic(join(runDir, RUN_FILE), JSON.stringify(state, null, 2) + '\n');
  writeAtomic(join(runDir, PROGRESS_FILE), renderProgress(state));
};

export const readRun = (
  runDir: string,
): { state?: RunState; error?: string } => {
  const path = join(runDir, RUN_FILE);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunState>;
    if (
      typeof raw.runId !== 'string' ||
      typeof raw.task !== 'string' ||
      !Array.isArray(raw.entries)
    ) {
      return { error: `invalid run state in ${path}` };
    }
    return {
      state: {
        runId: raw.runId,
        task: raw.task,
        startedAt: raw.startedAt ?? new Date().toISOString(),
        ...(raw.planArtifact ? { planArtifact: raw.planArtifact } : {}),
        reviewerAgent: raw.reviewerAgent ?? 'critic',
        deslop: raw.deslop !== false,
        iterations: raw.iterations ?? 0,
        reviewRounds: raw.reviewRounds ?? 0,
        changedFiles: raw.changedFiles ?? [],
        gitBaseline: raw.gitBaseline ?? [],
        patterns: raw.patterns ?? [],
        entries: raw.entries,
        reviews: raw.reviews ?? [],
        ...(raw.blockers ? { blockers: raw.blockers } : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `cannot read ${path}: ${message}` };
  }
};

// Most recently modified run directory that holds a run.json, or null.
export const findLatestRun = (cwd: string, stateDir: string): string | null => {
  const root = join(cwd, stateDir);
  if (!existsSync(root)) return null;
  let latest: { id: string; mtime: number } | null = null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runFile = join(root, entry.name, RUN_FILE);
    if (!existsSync(runFile)) continue;
    const mtime = statSync(runFile).mtimeMs;
    if (!latest || mtime > latest.mtime) latest = { id: entry.name, mtime };
  }
  return latest?.id ?? null;
};

// ---------------------------------------------------------------------------
// progress.md (OMC progress.txt layout: patterns on top, entries below).

export const renderProgress = (state: RunState): string => {
  const lines = [
    '# Ralph progress log',
    `Run: ${state.runId}`,
    `Started: ${state.startedAt}`,
    `Task: ${state.task}`,
    '',
    '## Codebase patterns',
    ...(state.patterns.length > 0
      ? state.patterns.map((p) => `- ${p}`)
      : ['(none discovered yet)']),
    '',
    '---',
  ];
  for (const entry of state.entries) {
    lines.push(
      '',
      `## [${entry.timestamp}] ${entry.storyId} attempt ${entry.attempt}: ${entry.outcome}`,
      '',
      entry.summary,
    );
    if (entry.filesChanged.length > 0) {
      lines.push(
        '',
        '**Files changed:**',
        ...entry.filesChanged.map((f) => `- ${f}`),
      );
    }
    if (entry.learnings.length > 0) {
      lines.push(
        '',
        '**Learnings for future iterations:**',
        ...entry.learnings.map((l) => `- ${l}`),
      );
    }
    lines.push('', '---');
  }
  return lines.join('\n') + '\n';
};

// Context injected into executor prompts (OMC getProgressContext):
// patterns, recent learnings, recent entries.
export const formatProgressContext = (state: RunState): string => {
  const parts: string[] = [];
  if (state.patterns.length > 0) {
    parts.push(
      '<codebase-patterns>\n' +
        state.patterns.map((p) => `- ${p}`).join('\n') +
        '\n</codebase-patterns>',
    );
  }
  const learnings = [
    ...new Set(state.entries.slice(-5).flatMap((e) => e.learnings)),
  ];
  if (learnings.length > 0) {
    parts.push(
      '<learnings>\n' +
        learnings.map((l) => `- ${l}`).join('\n') +
        '\n</learnings>',
    );
  }
  const recent = state.entries.slice(-3);
  if (recent.length > 0) {
    parts.push(
      '<recent-progress>\n' +
        recent
          .map(
            (e) =>
              `### ${e.storyId} attempt ${e.attempt} (${e.outcome})\n${e.summary}`,
          )
          .join('\n\n') +
        '\n</recent-progress>',
    );
  }
  return parts.join('\n\n');
};

export const addUnique = (target: string[], items: string[]): void => {
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed !== '' && !target.includes(trimmed)) target.push(trimmed);
  }
};
