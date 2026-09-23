// The ralph persistence loop, ported from oh-my-claudecode's ralph skill.
// Invariants:
//   1. prd.json is the completion authority and the loop owns it; children
//      report, the loop mutates (passes, amendments, notes).
//   2. A story passes only when the executor reports every active criterion
//      met with evidence AND the regression commands are green.
//   3. When all stories pass, an independent read-only reviewer verifies
//      every criterion; APPROVE with gaps is downgraded to REJECT and each
//      rejection re-opens stories (or adds a review story).
//   4. After approval: bounded deslop pass on changed files, then regression
//      re-verification (repair attempts bounded). Only then `completed`.
//   5. Budgets: maxIterations loop turns, maxReviewAttempts reviewer rounds,
//      MAX_STORY_ATTEMPTS consecutive failures of one story -> `blocked`.
//   6. The loop never commits.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RalphConfig, RoleConfig } from '../config.ts';
import { delegate, type DelegationResponse } from '../subagents/delegation.ts';
import { ROLE_AGENT_NAMES } from '../subagents/register-agents.ts';
import {
  addUsage,
  Cancelled,
  emptyUsage,
  RoleFailure,
  structuredOf,
  textOf,
} from '../subagents/responses.ts';
import {
  addReviewStory,
  amendCriterion,
  markStoryFailed,
  markStoryPassed,
  prdStatus,
  type Prd,
  type Story,
} from './prd.ts';
import {
  buildCleanerTask,
  buildExecutorTask,
  buildRegressionFixTask,
  buildReviewerTask,
} from './prompts.ts';
import {
  addUnique,
  formatProgressContext,
  writePrd,
  writeRun,
  type ProgressEntry,
  type RunState,
} from './state.ts';
import {
  EXECUTOR_REPORT_SCHEMA,
  REVIEW_REPORT_SCHEMA,
  type ExecutorReport,
  type RalphRequest,
  type RalphResult,
  type ReviewReport,
} from './types.ts';
import {
  allOk,
  gitDirtyFiles,
  runCommands,
  type CommandResult,
} from './verify.ts';

export type RalphRole = 'prd' | 'executor' | 'reviewer' | 'cleaner' | 'verify';

export interface RalphProgress {
  // 0 while the PRD is drafted
  iteration: number;
  role: RalphRole;
  phase: 'started' | 'finished';
  detail?: string;
}

export type Delegate = typeof delegate;

export interface RunLoopOptions {
  pi: ExtensionAPI;
  config: RalphConfig;
  request: RalphRequest;
  runDir: string;
  prd: Prd;
  state: RunState;
  signal?: AbortSignal;
  onProgress?: (progress: RalphProgress) => void;
  delegateFn?: Delegate;
}

// OMC: "if the same issue recurs across 3+ iterations, report it as a
// potential fundamental problem". We stop instead of burning budget.
export const MAX_STORY_ATTEMPTS = 3;
export const MAX_REGRESSION_FIXES = 2;

const BLOCKING = new Set(['CRITICAL', 'MAJOR']);

// Enforces the reviewer contract in code: APPROVE needs every active
// criterion of every story VERIFIED and no CRITICAL/MAJOR finding.
export const normalizeReview = (
  prd: Prd,
  review: ReviewReport,
): ReviewReport => {
  if (review.verdict !== 'APPROVE') return review;
  const reasons: string[] = [];
  const blocking = review.findings.filter((f) => BLOCKING.has(f.severity));
  if (blocking.length > 0)
    reasons.push(`${blocking.length} blocking finding(s)`);
  let uncovered = 0;
  let unverified = 0;
  for (const story of prd.userStories) {
    for (const criterion of story.acceptanceCriteria) {
      const entry = review.criteria.find(
        (c) => c.storyId === story.id && c.criterion.trim() === criterion,
      );
      if (!entry) uncovered++;
      else if (entry.status !== 'VERIFIED') unverified++;
    }
  }
  if (uncovered > 0) reasons.push(`${uncovered} criteria not covered`);
  if (unverified > 0) reasons.push(`${unverified} criteria not VERIFIED`);
  if (reasons.length === 0) return review;
  return {
    ...review,
    verdict: 'REJECT',
    summary: `${review.summary} [verdict downgraded from APPROVE: ${reasons.join('; ')}]`,
  };
};

const asExecutorReport = (value: unknown): ExecutorReport => {
  const report = value as ExecutorReport;
  if (
    !['done', 'incomplete', 'blocked'].includes(report?.status) ||
    typeof report.summary !== 'string' ||
    !Array.isArray(report.criteria)
  ) {
    throw new RoleFailure('executor', 'returned a malformed report');
  }
  return {
    ...report,
    filesChanged: report.filesChanged ?? [],
    amendments: report.amendments ?? [],
    learnings: report.learnings ?? [],
    patterns: report.patterns ?? [],
    blockers: report.blockers ?? [],
  };
};

const asReviewReport = (value: unknown): ReviewReport => {
  const report = value as ReviewReport;
  if (
    !['APPROVE', 'REJECT'].includes(report?.verdict) ||
    typeof report.summary !== 'string' ||
    report.summary.trim() === '' ||
    !Array.isArray(report.criteria) ||
    !Array.isArray(report.findings)
  ) {
    throw new RoleFailure('reviewer', 'returned a malformed report');
  }
  return { ...report, filesReviewed: report.filesReviewed ?? [] };
};

// Re-opens the stories a rejection points at; findings that name no story
// become a review story so the PRD stays the only completion authority.
export const applyRejection = (
  prd: Prd,
  review: ReviewReport,
  round: number,
): string[] => {
  const reopened = new Set<string>();
  const byId = new Map(prd.userStories.map((s) => [s.id, s]));
  const orphan: string[] = [];
  for (const finding of review.findings) {
    if (!BLOCKING.has(finding.severity)) continue;
    const story = byId.get(finding.storyId);
    const note = `reviewer round ${round} [${finding.severity}] ${finding.title}: ${finding.fix}`;
    if (story) {
      markStoryFailed(story, note);
      reopened.add(story.id);
    } else orphan.push(`${finding.title}: ${finding.fix}`);
  }
  for (const entry of review.criteria) {
    if (entry.status === 'VERIFIED') continue;
    const story = byId.get(entry.storyId);
    if (!story || !story.acceptanceCriteria.includes(entry.criterion.trim()))
      continue;
    markStoryFailed(
      story,
      `reviewer round ${round}: criterion ${entry.status}: "${entry.criterion}" (${entry.evidence})`,
    );
    reopened.add(story.id);
  }
  if (reopened.size === 0) {
    const criteria = orphan.length > 0 ? orphan : [review.summary];
    reopened.add(addReviewStory(prd, round, criteria).id);
  } else if (orphan.length > 0) {
    reopened.add(addReviewStory(prd, round, orphan).id);
  }
  return [...reopened];
};

export const runRalphLoop = async (
  options: RunLoopOptions,
): Promise<RalphResult> => {
  const { config, request, prd, state, runDir } = options;
  const usage = emptyUsage();
  const run = options.delegateFn ?? delegate;
  const authority = `ralph:${request.runId}`;
  const verifyCommands = config.verify.length > 0 ? config.verify : prd.verify;
  let deslop: RalphResult['deslop'] = request.deslop
    ? 'not-reached'
    : 'skipped';
  let lastVerify: CommandResult[] | null = null;

  const persist = (): void => {
    writePrd(runDir, prd);
    writeRun(runDir, state);
  };

  const done = (
    outcome: RalphResult['outcome'],
    extra: { note?: string; error?: string } = {},
  ): RalphResult => {
    persist();
    return {
      outcome,
      runId: request.runId,
      runDir,
      prd,
      iterations: state.iterations,
      reviews: state.reviews,
      changedFiles: state.changedFiles,
      deslop,
      usage,
      ...extra,
    };
  };

  const child = async (
    role: Exclude<RalphRole, 'verify' | 'prd'>,
    roleConfig: RoleConfig,
    agent: string,
    nodeId: string,
    task: string,
    schema?: Record<string, unknown>,
  ): Promise<DelegationResponse> => {
    const iteration = state.iterations;
    options.onProgress?.({ iteration, role, phase: 'started' });
    const response = await run(options.pi, {
      ownerRunId: request.runId,
      nodeId,
      agent,
      task,
      cwd: request.cwd,
      model: roleConfig.model,
      thinking: roleConfig.thinking,
      timeoutMs: roleConfig.timeoutMs,
      result: schema ? { kind: 'structured', schema } : { kind: 'text' },
      signal: options.signal,
    });
    addUsage(usage, response);
    options.onProgress?.({
      iteration,
      role,
      phase: 'finished',
      detail: response.status,
    });
    return response;
  };

  const verify = async (): Promise<CommandResult[]> => {
    if (verifyCommands.length === 0) return [];
    const iteration = state.iterations;
    options.onProgress?.({ iteration, role: 'verify', phase: 'started' });
    const results = await runCommands(
      verifyCommands,
      request.cwd,
      config.verifyTimeoutMs,
      options.signal,
    );
    options.onProgress?.({
      iteration,
      role: 'verify',
      phase: 'finished',
      detail: allOk(results) ? 'ok' : 'failed',
    });
    lastVerify = results;
    return results;
  };

  const recordChangedFiles = async (reported: string[]): Promise<void> => {
    addUnique(state.changedFiles, reported);
    const dirty = await gitDirtyFiles(request.cwd);
    if (!dirty) return;
    const baseline = new Set(state.gitBaseline);
    addUnique(
      state.changedFiles,
      dirty.filter((f) => !baseline.has(f)),
    );
  };

  const entry = (partial: Omit<ProgressEntry, 'timestamp'>): void => {
    state.entries.push({ timestamp: new Date().toISOString(), ...partial });
  };

  const executor = async (
    nodeId: string,
    task: string,
  ): Promise<ExecutorReport> =>
    asExecutorReport(
      structuredOf(
        'executor',
        await child(
          'executor',
          config.roles.executor,
          ROLE_AGENT_NAMES.executor,
          nodeId,
          task,
          EXECUTOR_REPORT_SCHEMA,
        ),
      ),
    );

  // One story attempt; returns a terminal outcome when the loop must stop.
  const attemptStory = async (
    story: Story,
  ): Promise<RalphResult['outcome'] | null> => {
    story.attempts++;
    const report = await executor(
      `ralph-${state.iterations}-executor-${story.id}`,
      buildExecutorTask(prd, story, {
        iteration: state.iterations,
        maxIterations: config.maxIterations,
        progressContext: formatProgressContext(state),
        verifyCommands,
        lastVerify,
      }),
    );
    await recordChangedFiles(report.filesChanged);
    addUnique(state.patterns, report.patterns);

    const problems: string[] = [];
    for (const amendment of report.amendments) {
      const error = amendCriterion(story, amendment, authority);
      if (error) problems.push(`amendment "${amendment.original}": ${error}`);
    }
    const unmet = story.acceptanceCriteria.filter(
      (criterion) =>
        !report.criteria.some((c) => c.criterion.trim() === criterion && c.met),
    );
    if (unmet.length > 0) {
      problems.push(`criteria not met or not reported: ${unmet.join(' | ')}`);
    }

    if (report.status === 'blocked') {
      const blockers = report.blockers.join('; ') || report.summary;
      markStoryFailed(story, `blocked: ${blockers}`);
      entry({
        storyId: story.id,
        attempt: story.attempts,
        outcome: 'blocked',
        summary: report.summary,
        filesChanged: report.filesChanged,
        learnings: report.learnings,
      });
      state.blockers = blockers;
      return 'blocked';
    }

    let outcome: ProgressEntry['outcome'] = 'failed';
    if (report.status === 'done' && problems.length === 0) {
      const results = await verify();
      if (allOk(results)) {
        markStoryPassed(story, report.summary);
        outcome = 'passed';
      } else {
        problems.push(
          `regression commands failed: ${results
            .filter((r) => !r.ok)
            .map((r) => r.command)
            .join(', ')}`,
        );
      }
    } else if (report.status === 'incomplete') {
      problems.unshift(`executor reported incomplete: ${report.summary}`);
    }
    if (outcome === 'failed') {
      markStoryFailed(
        story,
        `attempt ${story.attempts}: ${problems.join('; ')}`,
      );
    }
    entry({
      storyId: story.id,
      attempt: story.attempts,
      outcome,
      summary: report.summary,
      filesChanged: report.filesChanged,
      learnings: report.learnings,
    });
    if (outcome === 'failed' && story.attempts >= MAX_STORY_ATTEMPTS) {
      state.blockers = `${story.id} failed ${story.attempts} attempts: ${problems.join('; ')}`;
      return 'blocked';
    }
    return null;
  };

  const review = async (): Promise<ReviewReport> => {
    const reviewerAgent = ROLE_AGENT_NAMES[request.reviewerAgent];
    const results = await verify();
    const report = asReviewReport(
      structuredOf(
        'reviewer',
        await child(
          'reviewer',
          config.roles.reviewer,
          reviewerAgent,
          `ralph-${state.iterations}-reviewer-${state.reviewRounds}`,
          buildReviewerTask(prd, {
            round: state.reviewRounds,
            maxRounds: config.maxReviewAttempts,
            reviewerLabel: request.reviewerAgent,
            changedFiles: state.changedFiles,
            verify: results,
            previous: state.reviews.at(-1) ?? null,
          }),
          REVIEW_REPORT_SCHEMA,
        ),
      ),
    );
    return normalizeReview(prd, report);
  };

  // OMC 7.5 + 7.6: cleanup pass, then regression re-verification with
  // bounded repair attempts.
  const cleanup = async (): Promise<boolean> => {
    const summary = textOf(
      'cleaner',
      await child(
        'cleaner',
        config.roles.cleaner,
        ROLE_AGENT_NAMES.cleaner,
        `ralph-${state.iterations}-cleaner`,
        buildCleanerTask(state.changedFiles, verifyCommands),
      ),
    );
    await recordChangedFiles([]);
    entry({
      storyId: 'deslop',
      attempt: 1,
      outcome: 'cleanup',
      summary,
      filesChanged: [],
      learnings: [],
    });
    let results = await verify();
    for (let fix = 1; !allOk(results) && fix <= MAX_REGRESSION_FIXES; fix++) {
      const report = await executor(
        `ralph-${state.iterations}-regression-fix-${fix}`,
        buildRegressionFixTask(
          state.changedFiles,
          results,
          fix,
          MAX_REGRESSION_FIXES,
        ),
      );
      await recordChangedFiles(report.filesChanged);
      entry({
        storyId: 'deslop',
        attempt: fix,
        outcome: 'regression-fix',
        summary: report.summary,
        filesChanged: report.filesChanged,
        learnings: report.learnings,
      });
      results = await verify();
    }
    persist();
    return allOk(results);
  };

  try {
    while (state.iterations < config.maxIterations) {
      if (options.signal?.aborted) return done('aborted');
      state.iterations++;
      const status = prdStatus(prd);

      if (status.next) {
        const outcome = await attemptStory(status.next);
        persist();
        if (outcome) return done(outcome, { note: state.blockers });
        continue;
      }

      if (state.reviewRounds >= config.maxReviewAttempts) {
        return done('exhausted', {
          note: `reviewer did not approve after ${state.reviewRounds} round(s); all stories pass by executor evidence only`,
        });
      }
      state.reviewRounds++;
      const report = await review();
      state.reviews.push(report);
      if (report.verdict !== 'APPROVE') {
        const reopened = applyRejection(prd, report, state.reviewRounds);
        entry({
          storyId: 'review',
          attempt: state.reviewRounds,
          outcome: 'failed',
          summary: `${report.summary} (re-opened: ${reopened.join(', ')})`,
          filesChanged: [],
          learnings: [],
        });
        persist();
        continue;
      }
      for (const story of prd.userStories) story.reviewerVerified = true;
      entry({
        storyId: 'review',
        attempt: state.reviewRounds,
        outcome: 'passed',
        summary: report.summary,
        filesChanged: report.filesReviewed,
        learnings: [],
      });
      persist();

      if (request.deslop) {
        if (state.changedFiles.length === 0) deslop = 'skipped';
        else if (await cleanup()) deslop = 'done';
        else {
          deslop = 'failed';
          return done('failed', {
            error: 'post-cleanup regression commands still fail',
            note: 'reviewer approved; the cleanup pass broke the regression run and repair attempts failed. Inspect the working tree before using it.',
          });
        }
      }
      return done('completed');
    }
    return done('exhausted', {
      note: `iteration limit ${config.maxIterations} reached`,
    });
  } catch (error) {
    if (error instanceof Cancelled || options.signal?.aborted) {
      return done('aborted');
    }
    const message = error instanceof Error ? error.message : String(error);
    return done('failed', { error: message });
  }
};
