// On-disk state of one ralph run:
//   <stateRoot>/<projectKey>/<runId>/{prd.json, run.json, progress.md,
//   integrity.json}
// The state root lives outside the working tree (default
// `~/.pi/agent/spiral/ralph`) so writer children do not trip over it.
// That is NOT a security boundary: a child with a shell can reach any
// path. What we guarantee is detection: every persist first checks that
// the files still match what the loop wrote last (`integrity.json`), and a
// resume refuses a run whose files drifted unless the user forces it.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { normalizePrd, type Prd } from './prd.ts';
import type { RalphOutcome, ReviewReport, Verification } from './types.ts';

export const PRD_FILE = 'prd.json';
export const RUN_FILE = 'run.json';
export const PROGRESS_FILE = 'progress.md';
export const INTEGRITY_FILE = 'integrity.json';
export const LOCK_FILE = 'active.lock';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isRunId = (value: string): boolean => UUID.test(value);

export const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

// `~/x` or absolute; relative paths are rejected by config validation.
export const resolveStateRoot = (
  stateDir: string,
  homeDir = homedir(),
): string =>
  stateDir.startsWith('~/') ? join(homeDir, stateDir.slice(2)) : stateDir;

// Stable per-project directory name: readable prefix + hash of the path.
export const projectKey = (cwd: string): string =>
  `${basename(cwd).replace(/[^a-zA-Z0-9._-]/g, '_')}-${sha256(cwd).slice(0, 12)}`;

export const projectDirFor = (stateRoot: string, cwd: string): string =>
  join(stateRoot, projectKey(cwd));

export const runDirFor = (
  stateRoot: string,
  cwd: string,
  runId: string,
): string => {
  if (!isRunId(runId)) throw new Error(`invalid run id: ${runId}`);
  return join(projectDirFor(stateRoot, cwd), runId);
};

export type RunPhase = 'stories' | 'review' | 'cleanup' | 'done';

export interface ProgressEntry {
  timestamp: string;
  storyId: string;
  attempt: number;
  outcome:
    | 'passed'
    | 'failed'
    | 'blocked'
    | 'cleanup'
    | 'regression-fix'
    | 'verify-failed';
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
  // 'running' until the loop returns
  outcome: RalphOutcome | 'running';
  phase: RunPhase;
  // story attempts (review rounds have their own budget)
  iterations: number;
  reviewRounds: number;
  // regression commands in effect for this run (config, or confirmed PRD)
  verifyCommands: string[];
  verification: Verification;
  cleanupDone: boolean;
  // files touched during this run (executor reports + git delta)
  changedFiles: string[];
  // git-dirty paths before the run; excluded from the delta
  gitBaseline: string[];
  gitHead: string | null;
  patterns: string[];
  entries: ProgressEntry[];
  reviews: ReviewReport[];
  // why the run stopped with `blocked`, if it did
  blockers?: string;
}

const writeAtomic = (path: string, content: string): void => {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
};

const readIfExists = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8') : null;

export class StateDrift extends Error {
  constructor(files: string[]) {
    super(
      `ralph state modified outside the loop: ${files.join(', ')}. ` +
        'A child or another process wrote to the run directory.',
    );
    this.name = 'StateDrift';
  }
}

interface Integrity {
  prd: string;
  run: string;
}

// Owns the files of one run. Detects external edits between persists.
export class RunStore {
  readonly runDir: string;
  private integrity: Integrity | null = null;

  private constructor(runDir: string) {
    this.runDir = runDir;
  }

  static create(runDir: string): RunStore {
    mkdirSync(runDir, { recursive: true });
    return new RunStore(runDir);
  }

  // Opens an existing run and checks it against integrity.json. `drift`
  // lists files that do not match; the caller decides whether to go on.
  static open(runDir: string): { store: RunStore; drift: string[] } {
    const store = new RunStore(runDir);
    const raw = readIfExists(join(runDir, INTEGRITY_FILE));
    let drift: string[] = [];
    if (raw === null) {
      drift = [INTEGRITY_FILE];
    } else {
      try {
        const parsed = JSON.parse(raw) as Partial<Integrity>;
        if (typeof parsed.prd !== 'string' || typeof parsed.run !== 'string') {
          drift = [INTEGRITY_FILE];
        } else {
          store.integrity = { prd: parsed.prd, run: parsed.run };
          drift = store.currentDrift();
        }
      } catch {
        drift = [INTEGRITY_FILE];
      }
    }
    return { store, drift };
  }

  // Adopt the on-disk files as-is (after the user forced a resume).
  trustCurrent(): void {
    this.integrity = {
      prd: sha256(readIfExists(join(this.runDir, PRD_FILE)) ?? ''),
      run: sha256(readIfExists(join(this.runDir, RUN_FILE)) ?? ''),
    };
  }

  private currentDrift(): string[] {
    if (!this.integrity) return [];
    const drift: string[] = [];
    const prd = readIfExists(join(this.runDir, PRD_FILE)) ?? '';
    const run = readIfExists(join(this.runDir, RUN_FILE)) ?? '';
    if (sha256(prd) !== this.integrity.prd) drift.push(PRD_FILE);
    if (sha256(run) !== this.integrity.run) drift.push(RUN_FILE);
    return drift;
  }

  // Throws StateDrift when the files changed since the last persist.
  persist(prd: Prd, state: RunState): void {
    const drift = this.currentDrift();
    if (drift.length > 0) throw new StateDrift(drift);
    const prdText = JSON.stringify(prd, null, 2) + '\n';
    const runText = JSON.stringify(state, null, 2) + '\n';
    writeAtomic(join(this.runDir, PRD_FILE), prdText);
    writeAtomic(join(this.runDir, RUN_FILE), runText);
    writeAtomic(join(this.runDir, PROGRESS_FILE), renderProgress(state));
    this.integrity = { prd: sha256(prdText), run: sha256(runText) };
    writeAtomic(
      join(this.runDir, INTEGRITY_FILE),
      JSON.stringify(this.integrity, null, 2) + '\n',
    );
  }

  readPrd(): { prd?: Prd; error?: string } {
    const path = join(this.runDir, PRD_FILE);
    try {
      const prd = normalizePrd(JSON.parse(readFileSync(path, 'utf8')));
      return prd ? { prd } : { error: `invalid PRD structure in ${path}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `cannot read ${path}: ${message}` };
    }
  }

  readRun(): { state?: RunState; error?: string } {
    const path = join(this.runDir, RUN_FILE);
    try {
      const state = normalizeRun(JSON.parse(readFileSync(path, 'utf8')));
      return state ? { state } : { error: `invalid run state in ${path}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `cannot read ${path}: ${message}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Fail-closed run.json reader.

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const OUTCOMES = new Set([
  'running',
  'completed',
  'exhausted',
  'blocked',
  'aborted',
  'failed',
]);
const PHASES = new Set(['stories', 'review', 'cleanup', 'done']);
const VERIFICATIONS = new Set(['passed', 'failed', 'none']);
const ENTRY_OUTCOMES = new Set([
  'passed',
  'failed',
  'blocked',
  'cleanup',
  'regression-fix',
  'verify-failed',
]);

const normalizeEntry = (raw: unknown): ProgressEntry | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.timestamp !== 'string' ||
    typeof e.storyId !== 'string' ||
    typeof e.attempt !== 'number' ||
    typeof e.outcome !== 'string' ||
    !ENTRY_OUTCOMES.has(e.outcome) ||
    typeof e.summary !== 'string' ||
    !isStringArray(e.filesChanged) ||
    !isStringArray(e.learnings)
  ) {
    return null;
  }
  return {
    timestamp: e.timestamp,
    storyId: e.storyId,
    attempt: e.attempt,
    outcome: e.outcome as ProgressEntry['outcome'],
    summary: e.summary,
    filesChanged: e.filesChanged,
    learnings: e.learnings,
  };
};

export const normalizeRun = (raw: unknown): RunState | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.runId !== 'string' ||
    !isRunId(r.runId) ||
    typeof r.task !== 'string' ||
    typeof r.startedAt !== 'string' ||
    (r.planArtifact !== undefined && typeof r.planArtifact !== 'string') ||
    (r.reviewerAgent !== 'critic' && r.reviewerAgent !== 'architect') ||
    typeof r.deslop !== 'boolean' ||
    typeof r.outcome !== 'string' ||
    !OUTCOMES.has(r.outcome) ||
    typeof r.phase !== 'string' ||
    !PHASES.has(r.phase) ||
    !Number.isInteger(r.iterations) ||
    !Number.isInteger(r.reviewRounds) ||
    !isStringArray(r.verifyCommands) ||
    typeof r.verification !== 'string' ||
    !VERIFICATIONS.has(r.verification) ||
    typeof r.cleanupDone !== 'boolean' ||
    !isStringArray(r.changedFiles) ||
    !isStringArray(r.gitBaseline) ||
    (r.gitHead !== null && typeof r.gitHead !== 'string') ||
    !isStringArray(r.patterns) ||
    !Array.isArray(r.entries) ||
    !Array.isArray(r.reviews) ||
    (r.blockers !== undefined && typeof r.blockers !== 'string')
  ) {
    return null;
  }
  const entries = r.entries.map(normalizeEntry);
  if (entries.some((e) => e === null)) return null;
  return {
    runId: r.runId,
    task: r.task,
    startedAt: r.startedAt,
    ...(r.planArtifact ? { planArtifact: r.planArtifact as string } : {}),
    reviewerAgent: r.reviewerAgent,
    deslop: r.deslop,
    outcome: r.outcome as RunState['outcome'],
    phase: r.phase as RunPhase,
    iterations: r.iterations as number,
    reviewRounds: r.reviewRounds as number,
    verifyCommands: r.verifyCommands,
    verification: r.verification as Verification,
    cleanupDone: r.cleanupDone,
    changedFiles: r.changedFiles,
    gitBaseline: r.gitBaseline,
    gitHead: r.gitHead as string | null,
    patterns: r.patterns,
    entries: entries as ProgressEntry[],
    reviews: r.reviews as ReviewReport[],
    ...(r.blockers ? { blockers: r.blockers as string } : {}),
  };
};

// Most recently modified run of this project that holds a run.json.
export const findLatestRun = (projectDir: string): string | null => {
  if (!existsSync(projectDir)) return null;
  let latest: { id: string; mtime: number } | null = null;
  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isRunId(entry.name)) continue;
    const runFile = join(projectDir, entry.name, RUN_FILE);
    if (!existsSync(runFile)) continue;
    const mtime = statSync(runFile).mtimeMs;
    if (!latest || mtime > latest.mtime) latest = { id: entry.name, mtime };
  }
  return latest?.id ?? null;
};

// ---------------------------------------------------------------------------
// One active ralph run per project (covers two resumes of the same run and
// two runs sharing a working tree). Stale locks from dead processes are
// reclaimed.

export interface Lock {
  release(): void;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const acquireProjectLock = (projectDir: string): Lock => {
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return { release: () => rmSync(path, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readIfExists(path));
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        throw new Error(
          `another ralph run is active for this project (pid ${pid}); ` +
            `remove ${path} if that process is gone`,
        );
      }
      rmSync(path, { force: true });
    }
  }
  throw new Error(`cannot acquire ${path}`);
};

// ---------------------------------------------------------------------------
// progress.md (OMC progress.txt layout: patterns on top, entries below).

export const renderProgress = (state: RunState): string => {
  const lines = [
    '# Ralph progress log',
    `Run: ${state.runId}`,
    `Started: ${state.startedAt}`,
    `Task: ${state.task}`,
    `Outcome: ${state.outcome} (phase ${state.phase})`,
    `Verification: ${state.verification}` +
      (state.verifyCommands.length > 0
        ? ` (${state.verifyCommands.join(' && ')})`
        : ' (no commands)'),
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

// Ensure a path is a plain absolute path (used for plan artifacts).
export const absolute = (path: string, cwd: string): string =>
  isAbsolute(path) ? path : join(cwd, path);
