// ralph entry point: request parsing, PRD drafting / resume, loop.

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RalphConfig, ReviewerAgent } from '../config.ts';
import { delegate } from '../subagents/delegation.ts';
import { ROLE_AGENT_NAMES } from '../subagents/register-agents.ts';
import {
  addUsage,
  Cancelled,
  emptyUsage,
  structuredOf,
  type UsageTotals,
} from '../subagents/responses.ts';
import {
  checkDraft,
  prdFromDraft,
  PRD_DRAFT_SCHEMA,
  type Prd,
  type PrdDraft,
} from './prd.ts';
import { buildPrdTask } from './prompts.ts';
import {
  absolute,
  acquireProjectLock,
  findLatestRun,
  isRunId,
  projectDirFor,
  resolveStateRoot,
  runDirFor,
  RunStore,
  type RunState,
} from './state.ts';
import { runRalphLoop, type Delegate, type RalphProgress } from './loop.ts';
import type { RalphRequest, RalphResult } from './types.ts';
import { gitDirtyFiles, gitHead } from './verify.ts';

export type RalphRoleName = keyof RalphConfig['roles'];
export type RalphModelOverrides = Partial<Record<RalphRoleName, string>>;

export interface RalphOptions {
  pi: ExtensionAPI;
  config: RalphConfig;
  cwd: string;
  task: string;
  // path to a ralplan artifact to derive stories from
  plan?: string;
  // resume `<runId>` or 'latest'
  resume?: string;
  noDeslop?: boolean;
  reviewerAgent?: ReviewerAgent;
  models?: RalphModelOverrides;
  // The PRD planner may propose regression commands; they run only when
  // this callback (the user) confirms them. Absent = never run them.
  onConfirmVerify?: (commands: string[]) => Promise<boolean>;
  // Called when a resumed run's files do not match integrity.json; true
  // adopts the files as they are. Absent = refuse to resume.
  onConfirmDrift?: (files: string[]) => Promise<boolean>;
  signal?: AbortSignal;
  onProgress?: (progress: RalphProgress) => void;
  delegateFn?: Delegate;
  // test hook: home directory for `~/` in stateDir
  homeDir?: string;
}

export const applyRalphModelOverrides = (
  config: RalphConfig,
  models: RalphModelOverrides | undefined,
): RalphConfig => {
  if (!models) return config;
  const roles = { ...config.roles };
  for (const role of Object.keys(roles) as RalphRoleName[]) {
    const model = models[role];
    if (model) roles[role] = { ...roles[role], model };
  }
  return { ...config, roles };
};

const gitBranch = (cwd: string): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: 5000 },
      (error, stdout) => resolve(error ? 'ralph/task' : stdout.trim()),
    );
  });

const MAX_DRAFT_ATTEMPTS = 2;

// Drafts the PRD through the planner agent; one retry with the concrete
// problems when the draft is generic or malformed.
const draftPrd = async (
  options: RalphOptions,
  config: RalphConfig,
  request: RalphRequest,
  usage: UsageTotals,
): Promise<{ prd?: Prd; error?: string }> => {
  const run = options.delegateFn ?? delegate;
  const plan = request.planArtifact
    ? {
        path: request.planArtifact,
        content: readFileSync(request.planArtifact, 'utf8'),
      }
    : undefined;
  const branchName = await gitBranch(request.cwd);
  let problems: string[] = [];
  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
    options.onProgress?.({ iteration: 0, role: 'prd', phase: 'started' });
    const response = await run(options.pi, {
      ownerRunId: request.runId,
      nodeId: `ralph-prd-${attempt}`,
      agent: ROLE_AGENT_NAMES.planner,
      task: buildPrdTask(request.task, plan, problems),
      cwd: request.cwd,
      model: config.roles.prd.model,
      thinking: config.roles.prd.thinking,
      timeoutMs: config.roles.prd.timeoutMs,
      result: { kind: 'structured', schema: PRD_DRAFT_SCHEMA },
      signal: options.signal,
    });
    addUsage(usage, response);
    options.onProgress?.({
      iteration: 0,
      role: 'prd',
      phase: 'finished',
      detail: response.status,
    });
    const draft = structuredOf('prd', response) as PrdDraft;
    if (!draft || !Array.isArray(draft.stories)) {
      problems = ['draft is not an object with a stories array'];
      continue;
    }
    problems = checkDraft(draft);
    if (problems.length === 0) {
      return {
        prd: prdFromDraft(draft, {
          project: basename(request.cwd),
          branchName,
          planArtifact: request.planArtifact,
        }),
      };
    }
  }
  return { error: `PRD draft rejected: ${problems.join('; ')}` };
};

const EMPTY_PRD: Prd = {
  project: '',
  branchName: '',
  description: '',
  verify: [],
  userStories: [],
};

const failed = (
  request: RalphRequest,
  runDir: string,
  error: string,
  usage = emptyUsage(),
  outcome: RalphResult['outcome'] = 'failed',
): RalphResult => ({
  outcome,
  runId: request.runId,
  runDir,
  prd: EMPTY_PRD,
  iterations: 0,
  reviews: [],
  changedFiles: [],
  deslop: 'not-reached',
  verification: 'none',
  verifyCommands: [],
  headChanged: false,
  usage,
  error,
});

// Which regression commands this run may execute: config wins; PRD
// proposals need explicit confirmation (they come from a model).
const resolveVerifyCommands = async (
  options: RalphOptions,
  config: RalphConfig,
  prd: Prd,
): Promise<{ commands: string[]; note?: string }> => {
  if (config.verify.length > 0) return { commands: config.verify };
  if (prd.verify.length === 0) {
    return {
      commands: [],
      note: 'no regression commands: none in ralph.verify and none proposed by the PRD',
    };
  }
  const confirmed = (await options.onConfirmVerify?.(prd.verify)) === true;
  if (confirmed) return { commands: prd.verify };
  return {
    commands: [],
    note: `PRD proposed regression commands that were not confirmed and did not run: ${prd.verify.join(' && ')}. Set ralph.verify to run commands without asking.`,
  };
};

const withNote = (result: RalphResult, note?: string): RalphResult =>
  note
    ? { ...result, note: [result.note, note].filter(Boolean).join('; ') }
    : result;

export const runRalph = async (options: RalphOptions): Promise<RalphResult> => {
  const config = applyRalphModelOverrides(options.config, options.models);
  const reviewerAgent = options.reviewerAgent ?? config.reviewerAgent;
  const deslop = options.noDeslop ? false : config.deslop;
  const stateRoot = resolveStateRoot(config.stateDir, options.homeDir);
  const projectDir = projectDirFor(stateRoot, options.cwd);

  const base = (runId: string, resumed: boolean): RalphRequest => ({
    runId,
    task: options.task,
    cwd: options.cwd,
    deslop,
    reviewerAgent,
    resumed,
  });

  let lock: ReturnType<typeof acquireProjectLock>;
  try {
    lock = acquireProjectLock(projectDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(base('none', false) as RalphRequest, projectDir, message);
  }
  try {
    return options.resume
      ? await resumeRun(options, config, base)
      : await startRun(options, config, base);
  } finally {
    lock.release();
  }
};

const resumeRun = async (
  options: RalphOptions,
  config: RalphConfig,
  base: (runId: string, resumed: boolean) => RalphRequest,
): Promise<RalphResult> => {
  const stateRoot = resolveStateRoot(config.stateDir, options.homeDir);
  const projectDir = projectDirFor(stateRoot, options.cwd);
  const runId =
    options.resume === 'latest' ? findLatestRun(projectDir) : options.resume;
  if (!runId) {
    return failed(
      base('none', true),
      projectDir,
      'no previous ralph run found',
    );
  }
  if (!isRunId(runId)) {
    return failed(base('none', true), projectDir, `invalid run id: ${runId}`);
  }
  const request = base(runId, true);
  const runDir = runDirFor(stateRoot, options.cwd, runId);
  if (!existsSync(runDir)) {
    return failed(request, runDir, `run ${runId} not found for this project`);
  }
  const { store, drift } = RunStore.open(runDir);
  if (drift.length > 0) {
    const adopt = (await options.onConfirmDrift?.(drift)) === true;
    if (!adopt) {
      return failed(
        request,
        runDir,
        `run ${runId} was modified outside the loop (${drift.join(', ')}); not resumed`,
      );
    }
    store.trustCurrent();
  }
  const stored = store.readRun();
  const prd = store.readPrd();
  if (!stored.state || !prd.prd) {
    return failed(request, runDir, stored.error ?? prd.error ?? 'unreadable');
  }
  const state = stored.state;
  if (state.outcome === 'completed') {
    return failed(
      request,
      runDir,
      `run ${runId} already completed; start a new run instead`,
    );
  }
  if (state.runId !== runId) {
    return failed(request, runDir, 'run.json does not belong to this run');
  }
  request.task = state.task;
  request.planArtifact = state.planArtifact;
  request.deslop = state.deslop && request.deslop;
  state.outcome = 'running';
  return runRalphLoop({
    pi: options.pi,
    config,
    request,
    store,
    prd: prd.prd,
    state,
    signal: options.signal,
    onProgress: options.onProgress,
    delegateFn: options.delegateFn,
  });
};

const startRun = async (
  options: RalphOptions,
  config: RalphConfig,
  base: (runId: string, resumed: boolean) => RalphRequest,
): Promise<RalphResult> => {
  const stateRoot = resolveStateRoot(config.stateDir, options.homeDir);
  const request = base(crypto.randomUUID(), false);
  const runDir = runDirFor(stateRoot, options.cwd, request.runId);
  const usage = emptyUsage();
  if (options.plan) {
    request.planArtifact = absolute(options.plan, options.cwd);
    if (!existsSync(request.planArtifact)) {
      return failed(
        request,
        runDir,
        `plan artifact not found: ${request.planArtifact}`,
      );
    }
  }
  if (request.task.trim() === '') {
    return failed(request, runDir, 'a task description is required');
  }

  let drafted: Awaited<ReturnType<typeof draftPrd>>;
  try {
    drafted = await draftPrd(options, config, request, usage);
  } catch (error) {
    if (error instanceof Cancelled || options.signal?.aborted) {
      return failed(request, runDir, 'cancelled', usage, 'aborted');
    }
    const message = error instanceof Error ? error.message : String(error);
    return failed(request, runDir, message, usage);
  }
  if (!drafted.prd) {
    return failed(request, runDir, drafted.error ?? 'no PRD', usage);
  }

  const verify = await resolveVerifyCommands(options, config, drafted.prd);
  const state: RunState = {
    runId: request.runId,
    task: request.task,
    startedAt: new Date().toISOString(),
    ...(request.planArtifact ? { planArtifact: request.planArtifact } : {}),
    reviewerAgent: request.reviewerAgent,
    deslop: request.deslop,
    outcome: 'running',
    phase: 'stories',
    iterations: 0,
    reviewRounds: 0,
    verifyCommands: verify.commands,
    verification: 'none',
    cleanupDone: false,
    changedFiles: [],
    gitBaseline: (await gitDirtyFiles(options.cwd)) ?? [],
    gitHead: await gitHead(options.cwd),
    patterns: [],
    entries: [],
    reviews: [],
  };
  const store = RunStore.create(runDir);
  store.persist(drafted.prd, state);

  const result = await runRalphLoop({
    pi: options.pi,
    config,
    request,
    store,
    prd: drafted.prd,
    state,
    signal: options.signal,
    onProgress: options.onProgress,
    delegateFn: options.delegateFn,
  });
  // fold the PRD drafting usage into the run total
  for (const key of Object.keys(usage) as (keyof UsageTotals)[]) {
    result.usage[key] += usage[key];
  }
  return withNote(result, verify.note);
};

// ---------------------------------------------------------------------------
// `/ralph [--no-deslop] [--reviewer-agent critic|architect] [--plan <path>]
// [--resume [runId]] [--prd m] [--executor m] [--reviewer m] [--cleaner m]
// <task>`

export interface ParsedRalphArgs {
  task: string;
  plan?: string;
  resume?: string;
  noDeslop: boolean;
  reviewerAgent?: ReviewerAgent;
  models: RalphModelOverrides;
  errors: string[];
}

const ROLE_FLAGS: Record<string, RalphRoleName> = {
  '--prd': 'prd',
  '--executor': 'executor',
  '--reviewer': 'reviewer',
  '--cleaner': 'cleaner',
};

const REVIEWER_AGENTS: ReviewerAgent[] = ['critic', 'architect'];

export const parseRalphArgs = (raw: string): ParsedRalphArgs => {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const parsed: ParsedRalphArgs = {
    task: '',
    noDeslop: false,
    models: {},
    errors: [],
  };
  const rest: string[] = [];
  const valueOf = (i: number, flag: string): string | undefined => {
    const value = words[i + 1];
    if (!value || value.startsWith('--')) {
      parsed.errors.push(`${flag} requires a value`);
      return undefined;
    }
    return value;
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '--no-deslop') parsed.noDeslop = true;
    else if (word === '--resume') {
      const next = words[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.resume = next;
        i++;
        if (!isRunId(next)) {
          parsed.errors.push('--resume takes a run id (UUID) or nothing');
        }
      } else parsed.resume = 'latest';
    } else if (word === '--plan') {
      const value = valueOf(i, word);
      if (value) {
        parsed.plan = value;
        i++;
      }
    } else if (word === '--reviewer-agent') {
      const value = valueOf(i, word);
      if (value) {
        i++;
        if ((REVIEWER_AGENTS as string[]).includes(value)) {
          parsed.reviewerAgent = value as ReviewerAgent;
        } else {
          parsed.errors.push('--reviewer-agent must be critic | architect');
        }
      }
    } else if (word in ROLE_FLAGS) {
      const value = valueOf(i, word);
      if (value) {
        parsed.models[ROLE_FLAGS[word]] = value;
        i++;
      }
    } else rest.push(word);
  }
  parsed.task = rest.join(' ');
  if (parsed.task === '' && !parsed.resume) {
    parsed.errors.push('a task description (or --resume) is required');
  }
  return parsed;
};
