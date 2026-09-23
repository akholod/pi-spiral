export type CriticVerdict = 'APPROVE' | 'ITERATE' | 'REJECT';

export type CriticMode = 'THOROUGH' | 'ADVERSARIAL';

export type FindingSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface CriticFinding {
  severity: FindingSeverity;
  title: string;
  evidence: string;
  why: string;
  fix: string;
  confidence: Confidence;
}

export interface CriticAmbiguity {
  quote: string;
  interpretationA: string;
  interpretationB: string;
  riskIfWrong: string;
}

export interface CriticPerspectives {
  executor: string;
  stakeholder: string;
  skeptic: string;
}

export interface GateResult {
  pass: boolean;
  reason: string;
}

// The four ralplan gates from OMC's critic "Ralplan summary row".
export interface CriticGates {
  principleOptionConsistency: GateResult;
  alternativesDepth: GateResult;
  riskVerificationRigor: GateResult;
  deliberateAdditions: GateResult;
}

export interface CriticReview {
  verdict: CriticVerdict;
  mode: CriticMode;
  summary: string;
  preCommitment: string;
  findings: CriticFinding[];
  gaps: string[];
  ambiguities: CriticAmbiguity[];
  perspectives: CriticPerspectives;
  gates: CriticGates;
  justification: string;
  openQuestions: string[];
}

const gateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'reason'],
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
};

// JSON schema handed to pi-subagents as the critic's structured output.
// Mirrors OMC critic Output_Format minus code-only sections.
export const CRITIC_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'verdict',
    'mode',
    'summary',
    'preCommitment',
    'findings',
    'gaps',
    'ambiguities',
    'perspectives',
    'gates',
    'justification',
    'openQuestions',
  ],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'ITERATE', 'REJECT'] },
    mode: { type: 'string', enum: ['THOROUGH', 'ADVERSARIAL'] },
    summary: { type: 'string' },
    preCommitment: { type: 'string' },
    findings: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'evidence', 'why', 'fix', 'confidence'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
          confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
      },
    },
    gaps: { type: 'array', maxItems: 40, items: { type: 'string' } },
    ambiguities: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'quote',
          'interpretationA',
          'interpretationB',
          'riskIfWrong',
        ],
        properties: {
          quote: { type: 'string' },
          interpretationA: { type: 'string' },
          interpretationB: { type: 'string' },
          riskIfWrong: { type: 'string' },
        },
      },
    },
    perspectives: {
      type: 'object',
      additionalProperties: false,
      required: ['executor', 'stakeholder', 'skeptic'],
      properties: {
        executor: { type: 'string' },
        stakeholder: { type: 'string' },
        skeptic: { type: 'string' },
      },
    },
    gates: {
      type: 'object',
      additionalProperties: false,
      required: [
        'principleOptionConsistency',
        'alternativesDepth',
        'riskVerificationRigor',
        'deliberateAdditions',
      ],
      properties: {
        principleOptionConsistency: gateSchema,
        alternativesDepth: gateSchema,
        riskVerificationRigor: gateSchema,
        deliberateAdditions: gateSchema,
      },
    },
    justification: { type: 'string' },
    openQuestions: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
};

export type PlanMode = 'short' | 'deliberate';

export interface RalplanRequest {
  runId: string;
  task: string;
  cwd: string;
  mode: PlanMode;
  interactive: boolean;
}

// Interactive checkpoints (OMC ralplan steps 2 and 6). Returning
// `{ action: 'changes', feedback }` feeds the feedback to the planner as an
// extra revision round; 'skip' only applies to the draft checkpoint.
export type CheckpointDecision =
  | { action: 'proceed' }
  | { action: 'changes'; feedback: string }
  | { action: 'skip' }
  | { action: 'reject' };

export type Checkpoint = 'draft' | 'final';

export type CheckpointHandler = (
  checkpoint: Checkpoint,
  plan: string,
) => Promise<CheckpointDecision>;

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
  // number of child runs that reported usage
  runs: number;
}

export interface IterationRecord {
  iteration: number;
  plan: string;
  architectReview: string;
  criticReview: CriticReview;
}

export type RalplanOutcome =
  | 'approved' // critic APPROVE (and user approval when interactive)
  | 'exhausted' // maxIterations reached without APPROVE
  | 'rejected' // user rejected at a checkpoint
  | 'aborted' // cancelled via signal
  | 'failed'; // a role failed or violated the protocol

export interface RalplanResult {
  outcome: RalplanOutcome;
  iterations: IterationRecord[];
  finalPlan: string;
  usage: UsageTotals;
  // set only when a file was actually written
  artifactPath?: string;
  error?: string;
}
