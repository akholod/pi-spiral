// The ralplan consensus loop, ported from oh-my-claudecode's
// `/plan --consensus`. Invariants (see docs/ARCHITECTURE.md):
//   1. Planner drafts; Architect and Critic each review the SAME fixed
//      snapshot, sequentially, and neither sees the other's review.
//   2. Only the Planner synthesizes both reviews into a revision.
//   3. Loop until Critic returns a *clean* APPROVE (no CRITICAL/MAJOR
//      findings) or maxIterations is reached.
//   4. The loop never mutates the project; the only write is the artifact.
//   5. Interactive mode adds two user checkpoints: after the first draft and
//      after critic approval (OMC steps 2 and 6).

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RalplanConfig, RoleConfig } from '../config.ts';
import { delegate, type DelegationResponse } from '../subagents/delegation.ts';
import {
  ROLE_AGENT_NAMES,
  type RoleName,
} from '../subagents/register-agents.ts';
import {
  addUsage,
  Cancelled,
  emptyUsage,
  ensureNotCancelled,
  failureDetail,
  RoleFailure,
  textOf,
  type UsageTotals,
} from '../subagents/responses.ts';
import {
  buildArchitectTask,
  buildCriticTask,
  buildPlannerInitialTask,
  buildPlannerRevisionTask,
  buildPlannerUserFeedbackTask,
} from './prompts.ts';
import {
  CRITIC_REVIEW_SCHEMA,
  type CheckpointHandler,
  type CriticReview,
  type IterationRecord,
  type RalplanRequest,
  type RalplanResult,
} from './types.ts';

export interface LoopProgress {
  iteration: number;
  role: RoleName;
  phase: 'started' | 'finished';
  detail?: string;
}

// Injected so tests can drive the loop without pi-subagents.
export type Delegate = typeof delegate;

export interface RunLoopOptions {
  pi: ExtensionAPI;
  config: RalplanConfig;
  request: RalplanRequest;
  signal?: AbortSignal;
  onProgress?: (progress: LoopProgress) => void;
  onCheckpoint?: CheckpointHandler;
  delegateFn?: Delegate;
}

export type LoopResult = Omit<RalplanResult, 'artifactPath'>;

export { emptyUsage };

const BLOCKING = new Set(['CRITICAL', 'MAJOR']);

// Enforces the critic contract in code: APPROVE is only valid without
// CRITICAL/MAJOR findings and with every ralplan gate passing; otherwise it
// is downgraded to ITERATE so the loop cannot end on a contradictory review.
export const normalizeReview = (review: CriticReview): CriticReview => {
  if (review.verdict !== 'APPROVE') return review;
  const blocking = review.findings.filter((f) => BLOCKING.has(f.severity));
  const failedGates = Object.entries(review.gates)
    .filter(([, gate]) => !gate.pass)
    .map(([name]) => name);
  if (blocking.length === 0 && failedGates.length === 0) return review;
  const reasons: string[] = [];
  if (blocking.length > 0)
    reasons.push(`${blocking.length} blocking finding(s)`);
  if (failedGates.length > 0)
    reasons.push(`failed gates: ${failedGates.join(', ')}`);
  return {
    ...review,
    verdict: 'ITERATE',
    summary: `${review.summary} [verdict downgraded from APPROVE: ${reasons.join('; ')}]`,
  };
};

const reviewOf = (response: DelegationResponse): CriticReview => {
  ensureNotCancelled('critic', response);
  if (
    response.status !== 'completed' ||
    response.result?.kind !== 'structured'
  ) {
    throw new RoleFailure('critic', failureDetail(response));
  }
  const review = response.result.value as CriticReview;
  if (typeof review.summary !== 'string' || review.summary.trim() === '') {
    throw new RoleFailure('critic', 'returned an empty summary');
  }
  return normalizeReview(review);
};

const runRole = async (
  options: RunLoopOptions,
  usage: UsageTotals,
  role: RoleName,
  roleConfig: RoleConfig,
  iteration: number,
  nodeSuffix: string,
  task: string,
  structured: boolean,
): Promise<DelegationResponse> => {
  const run = options.delegateFn ?? delegate;
  options.onProgress?.({ iteration, role, phase: 'started' });
  const response = await run(options.pi, {
    ownerRunId: options.request.runId,
    nodeId: `ralplan-${iteration}-${role}${nodeSuffix}`,
    agent: ROLE_AGENT_NAMES[role],
    task,
    cwd: options.request.cwd,
    model: roleConfig.model,
    thinking: roleConfig.thinking,
    timeoutMs: roleConfig.timeoutMs,
    result: structured
      ? { kind: 'structured', schema: CRITIC_REVIEW_SCHEMA }
      : { kind: 'text' },
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

class UserRejected extends Error {
  constructor() {
    super('rejected by user');
    this.name = 'UserRejected';
  }
}

export const runRalplanLoop = async (
  options: RunLoopOptions,
): Promise<LoopResult> => {
  const { config, request } = options;
  const { roles } = config;
  const { task, mode } = request;
  const iterations: IterationRecord[] = [];
  const usage = emptyUsage();
  let plan = '';
  // set when the plan was already revised from user feedback and the next
  // iteration must go straight to review
  let reviewOnly = false;
  let feedbackRounds = 0;

  const planner = (iteration: number, suffix: string, text: string) =>
    runRole(
      options,
      usage,
      'planner',
      roles.planner,
      iteration,
      suffix,
      text,
      false,
    );

  const done = (
    outcome: LoopResult['outcome'],
    error?: string,
    note?: string,
  ): LoopResult => ({
    outcome,
    iterations,
    finalPlan: plan,
    usage,
    error,
    note,
  });

  const applyUserFeedback = async (
    iteration: number,
    feedback: string,
  ): Promise<void> => {
    feedbackRounds++;
    plan = textOf(
      'planner',
      await planner(
        iteration,
        `-feedback${feedbackRounds}`,
        buildPlannerUserFeedbackTask(task, mode, plan, feedback),
      ),
    );
  };

  // Asks the user at a checkpoint; returns feedback text if they requested
  // changes, 'skip' for the draft shortcut, or null to proceed.
  const checkpoint = async (
    kind: 'draft' | 'final',
  ): Promise<string | 'skip' | null> => {
    if (!request.interactive || !options.onCheckpoint) return null;
    const decision = await options.onCheckpoint(kind, plan);
    if (decision.action === 'reject') throw new UserRejected();
    if (decision.action === 'changes') return decision.feedback;
    if (decision.action === 'skip' && kind === 'draft') return 'skip';
    return null;
  };

  try {
    for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
      if (options.signal?.aborted) return done('aborted');

      const previous = iterations.at(-1);
      if (reviewOnly) {
        reviewOnly = false;
      } else {
        const plannerTask = previous
          ? buildPlannerRevisionTask(
              task,
              mode,
              iteration,
              previous.plan,
              previous.architectReview,
              previous.criticReview,
            )
          : buildPlannerInitialTask(task, mode);
        plan = textOf('planner', await planner(iteration, '', plannerTask));
      }

      // Checkpoint 1 (draft): user may request changes before any review.
      // Feedback rounds are bounded by the same maxIterations budget.
      if (iteration === 1) {
        let decision = await checkpoint('draft');
        while (typeof decision === 'string' && decision !== 'skip') {
          if (feedbackRounds >= config.maxIterations) break;
          await applyUserFeedback(iteration, decision);
          decision = await checkpoint('draft');
        }
        if (decision === 'skip') return done('approved');
      }

      // Fixed snapshot: both reviewers get `plan` as-is, in sequence.
      const architectReview = textOf(
        'architect',
        await runRole(
          options,
          usage,
          'architect',
          roles.architect,
          iteration,
          '',
          buildArchitectTask(task, mode, plan),
          false,
        ),
      );

      const criticReview = reviewOf(
        await runRole(
          options,
          usage,
          'critic',
          roles.critic,
          iteration,
          '',
          buildCriticTask(task, mode, plan),
          true,
        ),
      );

      iterations.push({ iteration, plan, architectReview, criticReview });

      if (criticReview.verdict !== 'APPROVE') continue;

      // Checkpoint 2 (final): user approves, or asks for changes, which
      // sends the plan through another full consensus round.
      const decision = await checkpoint('final');
      if (decision === null || decision === 'skip') return done('approved');
      // Feedback is applied right away so it is never lost; the review of
      // the revised plan needs one more iteration of budget.
      await applyUserFeedback(iteration, decision);
      if (iteration === config.maxIterations) {
        return done(
          'exhausted',
          undefined,
          'user feedback applied to the plan but not reviewed: iteration limit reached',
        );
      }
      reviewOnly = true;
    }
    return done('exhausted');
  } catch (error) {
    if (error instanceof UserRejected) return done('rejected');
    if (error instanceof Cancelled || options.signal?.aborted) {
      return done('aborted');
    }
    const message = error instanceof Error ? error.message : String(error);
    return done('failed', message);
  }
};
