// The ralph persistence loop, ported from oh-my-claudecode's ralph skill.
// Invariants:
//   1. prd.json is the completion authority and the loop owns it; children
//      report, the loop mutates (passes, amendments, notes). External edits
//      to the run directory are detected on every persist (StateDrift).
//   2. A story passes only when the executor reports every active criterion
//      met WITH evidence AND the regression commands are green.
//   3. When all stories pass, the regression commands must be green before
//      the reviewer is even asked; a red run re-opens the PRD instead.
//   4. An independent read-only reviewer verifies every criterion with
//      evidence; APPROVE with gaps is downgraded to REJECT and each
//      rejection re-opens stories (or adds a review story).
//   5. After approval: bounded deslop pass on changed files, scope check
//      (cleanup may not touch other files), regression re-verification with
//      bounded repair. A repair means the reviewer must look again.
//   6. Budgets: maxIterations story attempts, maxReviewAttempts reviewer
//      rounds, MAX_STORY_ATTEMPTS consecutive failures of one story.
//   7. The loop never commits; a moved HEAD is reported, not hidden.

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
  MIN_EVIDENCE_LENGTH,
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
  StateDrift,
  type ProgressEntry,
  type RunState,
  type RunStore,
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
  gitHead,
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
  store: RunStore;
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

const hasEvidence = (evidence: string): boolean =>
  evidence.trim().length >= MIN_EVIDENCE_LENGTH;

// Enforces the reviewer contract in code: APPROVE needs every active
// criterion of every story VERIFIED with substantive evidence and no
// CRITICAL/MAJOR finding.
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
  let unsupported = 0;
  for (const story of prd.userStories) {
    for (const criterion of story.acceptanceCriteria) {
      const entry = review.criteria.find(
        (c) => c.storyId === story.id && c.criterion.trim() === criterion,
      );
      if (!entry) uncovered++;
      else if (entry.status !== 'VERIFIED') unverified++;
      else if (!hasEvidence(entry.evidence)) unsupported++;
    }
  }
  if (uncovered > 0) reasons.push(`${uncovered} criteria not covered`);
  if (unverified > 0) reasons.push(`${unverified} criteria not VERIFIED`);
  if (unsupported > 0)
    reasons.push(`${unsupported} criteria VERIFIED without evidence`);
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
    const story = byId.get(entry.storyId);
    if (!story || !story.acceptanceCriteria.includes(entry.criterion.trim()))
      continue;
    if (entry.status === 'VERIFIED' && hasEvidence(entry.evidence)) continue;
    const why =
      entry.status === 'VERIFIED' ? 'VERIFIED without evidence' : entry.status;
    markStoryFailed(
      story,
      `reviewer round ${round}: criterion ${why}: "${entry.criterion}" (${entry.evidence})`,
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

const OUTPUT_NOTE = 1500;

export const runRalphLoop = async (
  options: RunLoopOptions,
): Promise<RalphResult> => {
  const { config, request, prd, state, store } = options;
  const usage = emptyUsage();
  const run = options.delegateFn ?? delegate;
  const authority = `ralph:${request.runId}`;
  const verifyCommands = state.verifyCommands;
  let deslop: RalphResult['deslop'] = request.deslop
    ? state.cleanupDone
      ? 'done'
      : 'not-reached'
    : 'skipped';
  let lastVerify: CommandResult[] | null = null;

  const persist = (): void => store.persist(prd, state);

  const finish = async (
    outcome: RalphResult['outcome'],
    extra: { note?: string; error?: string } = {},
  ): Promise<RalphResult> => {
    state.outcome = outcome;
    if (outcome === 'completed') state.phase = 'done';
    const head = await gitHead(request.cwd);
    const headChanged = state.gitHead !== null && head !== state.gitHead;
    try {
      persist();
    } catch (error) {
      if (!(error instanceof StateDrift)) throw error;
      extra = {
        error: extra.error ?? error.message,
        note: [extra.note, error.message].filter(Boolean).join('; '),
      };
      outcome = 'failed';
    }
    return {
      outcome,
      runId: request.runId,
      runDir: store.runDir,
      prd,
      iterations: state.iterations,
      reviews: state.reviews,
      changedFiles: state.changedFiles,
      deslop,
      verification: state.verification,
      verifyCommands,
      headChanged,
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

  // Runs the regression commands and records the verification state.
  // With no commands there is no verification, and that is reported as
  // such rather than as a pass.
  const verify = async (): Promise<CommandResult[]> => {
    if (verifyCommands.length === 0) {
      state.verification = 'none';
      return [];
    }
    const iteration = state.iterations;
    options.onProgress?.({ iteration, role: 'verify', phase: 'started' });
    const results = await runCommands(
      verifyCommands,
      request.cwd,
      config.verifyTimeoutMs,
      options.signal,
    );
    state.verification = allOk(results) ? 'passed' : 'failed';
    options.onProgress?.({
      iteration,
      role: 'verify',
      phase: 'finished',
      detail: state.verification,
    });
    lastVerify = results;
    return results;
  };

  const gitDelta = async (): Promise<string[] | null> => {
    const dirty = await gitDirtyFiles(request.cwd);
    if (!dirty) return null;
    const baseline = new Set(state.gitBaseline);
    return dirty.filter((f) => !baseline.has(f));
  };

  const recordChangedFiles = async (reported: string[]): Promise<void> => {
    addUnique(state.changedFiles, reported);
    const delta = await gitDelta();
    if (delta) addUnique(state.changedFiles, delta);
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

  const failedCommands = (results: CommandResult[]): string =>
    results
      .filter((r) => !r.ok)
      .map((r) => r.command)
      .join(', ');

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
    const unmet: string[] = [];
    const unsupported: string[] = [];
    for (const criterion of story.acceptanceCriteria) {
      const check = report.criteria.find(
        (c) => c.criterion.trim() === criterion && c.met,
      );
      if (!check) unmet.push(criterion);
      else if (!hasEvidence(check.evidence)) unsupported.push(criterion);
    }
    if (unmet.length > 0) {
      problems.push(`criteria not met or not reported: ${unmet.join(' | ')}`);
    }
    if (unsupported.length > 0) {
      problems.push(
        `criteria claimed met without evidence (>= ${MIN_EVIDENCE_LENGTH} chars needed): ${unsupported.join(' | ')}`,
      );
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
        problems.push(`regression commands failed: ${failedCommands(results)}`);
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

  // A red regression run re-opens the PRD; the reviewer is not asked.
  const reopenForRegression = (results: CommandResult[]): void => {
    const failing = results.filter((r) => !r.ok);
    const story = addReviewStory(
      prd,
      state.reviewRounds + 1,
      failing.map((r) => `\`${r.command}\` exits 0`),
    );
    story.title = 'Regression commands fail';
    story.description =
      'The regression commands failed before the completion review. ' +
      'Make them pass without weakening them.';
    for (const r of failing) {
      story.notes.push(
        `${r.command} (exit ${r.exitCode ?? '?'}): ${r.output.slice(-OUTPUT_NOTE)}`,
      );
    }
    entry({
      storyId: story.id,
      attempt: 0,
      outcome: 'verify-failed',
      summary: `regression commands failed before review: ${failedCommands(results)}`,
      filesChanged: [],
      learnings: [],
    });
  };

  const review = async (): Promise<ReviewReport> => {
    const reviewerAgent = ROLE_AGENT_NAMES[request.reviewerAgent];
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
            verify: lastVerify ?? [],
            previous: state.reviews.at(-1) ?? null,
          }),
          REVIEW_REPORT_SCHEMA,
        ),
      ),
    );
    return normalizeReview(prd, report);
  };

  // OMC 7.5 + 7.6: cleanup pass, scope check, regression re-verification
  // with bounded repair. `repaired` means code changed after the review.
  const cleanup = async (): Promise<{
    ok: boolean;
    repaired: boolean;
    outOfScope: string[];
  }> => {
    const scope = new Set(state.changedFiles);
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
    entry({
      storyId: 'deslop',
      attempt: 1,
      outcome: 'cleanup',
      summary,
      filesChanged: [],
      learnings: [],
    });
    let results = await verify();
    let repaired = false;
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
      repaired = true;
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
    const delta = await gitDelta();
    const outOfScope = delta ? delta.filter((f) => !scope.has(f)) : [];
    return { ok: allOk(results), repaired, outOfScope };
  };

  try {
    for (;;) {
      if (options.signal?.aborted) return finish('aborted');
      const status = prdStatus(prd);

      if (status.next) {
        state.phase = 'stories';
        if (state.iterations >= config.maxIterations) {
          return finish('exhausted', {
            note: `story attempt limit ${config.maxIterations} reached with ${status.pending.length} story(ies) open`,
          });
        }
        state.iterations++;
        const outcome = await attemptStory(status.next);
        persist();
        if (outcome) return finish(outcome, { note: state.blockers });
        continue;
      }

      // Every story passes. Regression must be green before review.
      state.phase = 'review';
      const results = await verify();
      if (!allOk(results)) {
        reopenForRegression(results);
        persist();
        continue;
      }
      if (state.reviewRounds >= config.maxReviewAttempts) {
        return finish('exhausted', {
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

      if (!request.deslop || state.cleanupDone) return finish('completed');
      if (state.changedFiles.length === 0) {
        deslop = 'skipped';
        return finish('completed');
      }
      state.phase = 'cleanup';
      const cleaned = await cleanup();
      state.cleanupDone = true;
      persist();
      if (cleaned.outOfScope.length > 0) {
        deslop = 'failed';
        return finish('failed', {
          error: `cleanup touched files outside the run's scope: ${cleaned.outOfScope.join(', ')}`,
          note: 'reviewer approved the pre-cleanup code; inspect the working tree before using it.',
        });
      }
      if (!cleaned.ok) {
        deslop = 'failed';
        return finish('failed', {
          error: 'post-cleanup regression commands still fail',
          note: 'reviewer approved the pre-cleanup code; the cleanup pass broke the regression run and repair attempts failed. Inspect the working tree before using it.',
        });
      }
      deslop = 'done';
      if (cleaned.repaired) {
        // Code changed after the approval: the reviewer must look again.
        for (const story of prd.userStories) story.reviewerVerified = false;
        entry({
          storyId: 'review',
          attempt: state.reviewRounds,
          outcome: 'failed',
          summary:
            'post-cleanup repair changed code after approval; re-review required',
          filesChanged: [],
          learnings: [],
        });
        persist();
        continue;
      }
      return finish('completed');
    }
  } catch (error) {
    if (error instanceof Cancelled || options.signal?.aborted) {
      return finish('aborted');
    }
    const message = error instanceof Error ? error.message : String(error);
    return finish('failed', { error: message });
  }
};
