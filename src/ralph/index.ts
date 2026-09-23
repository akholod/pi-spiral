// ralph entry point: request parsing, PRD drafting / resume, loop.

import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
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
  createRunDir,
  findLatestRun,
  readPrd,
  readRun,
  runDirFor,
  writePrd,
  writeRun,
  type RunState,
} from './state.ts';
import { runRalphLoop, type Delegate, type RalphProgress } from './loop.ts';
import type { RalphRequest, RalphResult } from './types.ts';
import { gitDirtyFiles } from './verify.ts';

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
  signal?: AbortSignal;
  onProgress?: (progress: RalphProgress) => void;
  delegateFn?: Delegate;
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
  usage: ReturnType<typeof emptyUsage>,
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

const failed = (
  request: RalphRequest,
  runDir: string,
  error: string,
  usage = emptyUsage(),
): RalphResult => ({
  outcome: 'failed',
  runId: request.runId,
  runDir,
  prd: {
    project: '',
    branchName: '',
    description: '',
    verify: [],
    userStories: [],
  },
  iterations: 0,
  reviews: [],
  changedFiles: [],
  deslop: 'not-reached',
  usage,
  error,
});

export const runRalph = async (options: RalphOptions): Promise<RalphResult> => {
  const config = applyRalphModelOverrides(options.config, options.models);
  const reviewerAgent = options.reviewerAgent ?? config.reviewerAgent;
  const deslop = options.noDeslop ? false : config.deslop;
  const usage = emptyUsage();

  // Resume: state and PRD come from disk, nothing is re-drafted.
  if (options.resume) {
    const runId =
      options.resume === 'latest'
        ? findLatestRun(options.cwd, config.stateDir)
        : options.resume;
    const runDir = runDirFor(options.cwd, config.stateDir, runId ?? 'none');
    const request: RalphRequest = {
      runId: runId ?? 'none',
      task: options.task,
      cwd: options.cwd,
      deslop,
      reviewerAgent,
      resumed: true,
    };
    if (!runId) return failed(request, runDir, 'no previous ralph run found');
    const stored = readRun(runDir);
    const prd = readPrd(runDir);
    if (!stored.state || !prd.prd) {
      return failed(request, runDir, stored.error ?? prd.error ?? 'unreadable');
    }
    request.task = stored.state.task;
    request.planArtifact = stored.state.planArtifact;
    return runRalphLoop({
      pi: options.pi,
      config,
      request,
      runDir,
      prd: prd.prd,
      state: stored.state,
      signal: options.signal,
      onProgress: options.onProgress,
      delegateFn: options.delegateFn,
    });
  }

  const planArtifact = options.plan
    ? isAbsolute(options.plan)
      ? options.plan
      : join(options.cwd, options.plan)
    : undefined;
  const request: RalphRequest = {
    runId: crypto.randomUUID(),
    task: options.task,
    cwd: options.cwd,
    planArtifact,
    deslop,
    reviewerAgent,
    resumed: false,
  };
  const runDir = runDirFor(options.cwd, config.stateDir, request.runId);
  if (planArtifact && !existsSync(planArtifact)) {
    return failed(request, runDir, `plan artifact not found: ${planArtifact}`);
  }

  let drafted: Awaited<ReturnType<typeof draftPrd>>;
  try {
    drafted = await draftPrd(options, config, request, usage);
  } catch (error) {
    if (error instanceof Cancelled || options.signal?.aborted) {
      return {
        ...failed(request, runDir, 'cancelled', usage),
        outcome: 'aborted',
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return failed(request, runDir, message, usage);
  }
  if (!drafted.prd)
    return failed(request, runDir, drafted.error ?? 'no PRD', usage);

  const state: RunState = {
    runId: request.runId,
    task: request.task,
    startedAt: new Date().toISOString(),
    ...(planArtifact ? { planArtifact } : {}),
    reviewerAgent,
    deslop,
    iterations: 0,
    reviewRounds: 0,
    changedFiles: [],
    gitBaseline: (await gitDirtyFiles(options.cwd)) ?? [],
    patterns: [],
    entries: [],
    reviews: [],
  };
  createRunDir(runDir);
  writePrd(runDir, drafted.prd);
  writeRun(runDir, state);

  const result = await runRalphLoop({
    pi: options.pi,
    config,
    request,
    runDir,
    prd: drafted.prd,
    state,
    signal: options.signal,
    onProgress: options.onProgress,
    delegateFn: options.delegateFn,
  });
  // fold the PRD drafting usage into the run total
  for (const key of Object.keys(usage) as (keyof typeof usage)[]) {
    result.usage[key] += usage[key];
  }
  return result;
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
        } else
          parsed.errors.push(`--reviewer-agent must be critic | architect`);
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
