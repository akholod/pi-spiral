import type { ReviewerAgent } from '../config.ts';
import type { UsageTotals } from '../subagents/responses.ts';
import type { AmendmentInput, Prd } from './prd.ts';

export type { UsageTotals };

// ---------------------------------------------------------------------------
// Executor report (structured output of one story attempt).

export interface CriterionCheck {
  criterion: string;
  met: boolean;
  evidence: string;
}

export type ExecutorStatus = 'done' | 'incomplete' | 'blocked';

export interface ExecutorReport {
  status: ExecutorStatus;
  summary: string;
  filesChanged: string[];
  criteria: CriterionCheck[];
  amendments: AmendmentInput[];
  learnings: string[];
  patterns: string[];
  // only for status 'blocked': what the user must resolve
  blockers: string[];
}

export const EXECUTOR_REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'summary',
    'filesChanged',
    'criteria',
    'amendments',
    'learnings',
    'patterns',
    'blockers',
  ],
  properties: {
    status: { type: 'string', enum: ['done', 'incomplete', 'blocked'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', maxItems: 200, items: { type: 'string' } },
    criteria: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'met', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          met: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    amendments: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'original', 'reason', 'evidence'],
        properties: {
          kind: { type: 'string', enum: ['replaced', 'superseded'] },
          original: { type: 'string' },
          replacement: { type: 'string' },
          reason: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    learnings: { type: 'array', maxItems: 20, items: { type: 'string' } },
    patterns: { type: 'array', maxItems: 20, items: { type: 'string' } },
    blockers: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
};

// ---------------------------------------------------------------------------
// Reviewer report (structured output of the completion review).

export type CriterionStatus = 'VERIFIED' | 'PARTIAL' | 'MISSING';

export interface ReviewCriterion {
  storyId: string;
  criterion: string;
  status: CriterionStatus;
  evidence: string;
}

export interface ReviewFinding {
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  // '' when the finding is not about one story
  storyId: string;
  title: string;
  evidence: string;
  fix: string;
}

export interface ReviewReport {
  verdict: 'APPROVE' | 'REJECT';
  summary: string;
  criteria: ReviewCriterion[];
  findings: ReviewFinding[];
  // is there a meaningfully simpler/faster/more maintainable approach?
  optimality: string;
  filesReviewed: string[];
}

export const REVIEW_REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'verdict',
    'summary',
    'criteria',
    'findings',
    'optimality',
    'filesReviewed',
  ],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REJECT'] },
    summary: { type: 'string' },
    criteria: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['storyId', 'criterion', 'status', 'evidence'],
        properties: {
          storyId: { type: 'string' },
          criterion: { type: 'string' },
          status: { type: 'string', enum: ['VERIFIED', 'PARTIAL', 'MISSING'] },
          evidence: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'storyId', 'title', 'evidence', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR'] },
          storyId: { type: 'string' },
          title: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    optimality: { type: 'string' },
    filesReviewed: { type: 'array', maxItems: 200, items: { type: 'string' } },
  },
};

// ---------------------------------------------------------------------------
// Run request / result.

export interface RalphRequest {
  runId: string;
  task: string;
  cwd: string;
  planArtifact?: string;
  deslop: boolean;
  reviewerAgent: ReviewerAgent;
  resumed: boolean;
}

export type RalphOutcome =
  | 'completed' // all stories pass, reviewer approved, deslop + regression ok
  | 'exhausted' // iteration or review budget spent
  | 'blocked' // executor needs user input, or a story keeps failing
  | 'aborted' // cancelled via signal
  | 'failed'; // a role failed, or the post-deslop regression stayed red

export type DeslopStatus = 'done' | 'skipped' | 'failed' | 'not-reached';

export interface RalphResult {
  outcome: RalphOutcome;
  runId: string;
  runDir: string;
  prd: Prd;
  iterations: number;
  reviews: ReviewReport[];
  changedFiles: string[];
  deslop: DeslopStatus;
  usage: UsageTotals;
  note?: string;
  error?: string;
}
