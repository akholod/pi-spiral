// Task builders for each role. The role *system* prompts live in agents/*.md;
// these functions produce the per-run user task with the current plan
// snapshot and prior feedback.

import type { CriticReview, PlanMode } from './types.ts';

const HIGH_RISK_PATTERN =
  /\b(auth|oauth|jwt|session|password|secret|token|migration|migrate|drop|delete|destructive|truncate|production|prod|incident|compliance|gdpr|pii|public api|breaking)\b/i;

export const detectPlanMode = (
  task: string,
  setting: 'auto' | 'always' | 'never',
): PlanMode => {
  if (setting === 'always') return 'deliberate';
  if (setting === 'never') return 'short';
  return HIGH_RISK_PATTERN.test(task) ? 'deliberate' : 'short';
};

const modeBlock = (mode: PlanMode): string =>
  mode === 'deliberate'
    ? [
        'MODE: DELIBERATE. In addition to the RALPLAN-DR summary you MUST',
        'include a pre-mortem with 3 failure scenarios and an expanded test',
        'plan covering unit, integration, e2e and observability.',
      ].join(' ')
    : 'MODE: SHORT. Include the compact RALPLAN-DR summary only.';

export const buildPlannerInitialTask = (task: string, mode: PlanMode): string =>
  [
    '# Ralplan: draft the initial plan',
    '',
    modeBlock(mode),
    '',
    'Investigate the codebase as needed (read-only), then output the full',
    'plan in Markdown as your final message. Do not write any files.',
    '',
    '## Task',
    task,
  ].join('\n');

const list = (items: string[]): string[] =>
  items.length > 0 ? items.map((item) => `- ${item}`) : ['(none)'];

// Renders a structured critic review as Markdown. Shared by the planner
// revision task and the artifact history.
export const formatCriticReview = (review: CriticReview): string => {
  const findings = review.findings.map((finding) =>
    [
      `- [${finding.severity}] ${finding.title} (confidence ${finding.confidence})`,
      `  Evidence: ${finding.evidence}`,
      `  Why: ${finding.why}`,
      `  Fix: ${finding.fix}`,
    ].join('\n'),
  );
  const ambiguities = review.ambiguities.map(
    (item) =>
      `- "${item.quote}" -> A: ${item.interpretationA} / B: ${item.interpretationB}; risk: ${item.riskIfWrong}`,
  );
  const gates = Object.entries(review.gates).map(
    ([name, gate]) =>
      `- ${name}: ${gate.pass ? 'PASS' : 'FAIL'} - ${gate.reason}`,
  );
  const { perspectives } = review;
  return [
    `Verdict: ${review.verdict} (${review.mode} mode)`,
    `Summary: ${review.summary}`,
    '',
    '### Pre-commitment',
    review.preCommitment,
    '',
    '### Findings',
    ...(findings.length > 0 ? findings : ['(none)']),
    '',
    "### What's missing",
    ...list(review.gaps),
    '',
    '### Ambiguity risks',
    ...(ambiguities.length > 0 ? ambiguities : ['(none)']),
    '',
    '### Multi-perspective notes',
    `- Executor: ${perspectives.executor}`,
    `- Stakeholder: ${perspectives.stakeholder}`,
    `- Skeptic: ${perspectives.skeptic}`,
    '',
    '### Ralplan gates',
    ...gates,
    '',
    '### Verdict justification',
    review.justification,
    '',
    '### Open questions',
    ...list(review.openQuestions),
  ].join('\n');
};

export const buildPlannerRevisionTask = (
  task: string,
  mode: PlanMode,
  iteration: number,
  plan: string,
  architectReview: string,
  criticReview: CriticReview,
): string =>
  [
    `# Ralplan: revise the plan (iteration ${iteration})`,
    '',
    modeBlock(mode),
    '',
    'You are the only role that synthesizes feedback. Combine the Architect',
    'and Critic reviews below, address every CRITICAL and MAJOR finding, and',
    'output the complete revised plan in Markdown as your final message.',
    'Do not write any files. Keep the ADR section up to date.',
    '',
    '## Original task',
    task,
    '',
    '## Current plan',
    plan,
    '',
    '## Architect review',
    architectReview,
    '',
    '## Critic review',
    formatCriticReview(criticReview),
  ].join('\n');

// User feedback from an interactive checkpoint: the plan is revised before
// it goes to the reviewers (or, at the final checkpoint, before another
// consensus round).
export const buildPlannerUserFeedbackTask = (
  task: string,
  mode: PlanMode,
  plan: string,
  feedback: string,
): string =>
  [
    '# Ralplan: revise the plan per user feedback',
    '',
    modeBlock(mode),
    '',
    'The user reviewed the plan below and requested changes. Apply them,',
    'keep everything else intact, and output the complete revised plan in',
    'Markdown as your final message. Do not write any files.',
    '',
    '## Original task',
    task,
    '',
    '## Current plan',
    plan,
    '',
    '## User feedback',
    feedback,
  ].join('\n');

export const buildArchitectTask = (
  task: string,
  mode: PlanMode,
  plan: string,
): string =>
  [
    '# Ralplan: architect review',
    '',
    modeBlock(mode),
    '',
    'Review the fixed plan snapshot below for architectural soundness.',
    'Provide the strongest steelman antithesis, at least one real tradeoff',
    'tension, and a synthesis when possible. Verify claims against the',
    'codebase (read-only). Do not rewrite the plan and do not write files.',
    '',
    '## Original task',
    task,
    '',
    '## Plan snapshot',
    plan,
  ].join('\n');

export const buildCriticTask = (
  task: string,
  mode: PlanMode,
  plan: string,
): string =>
  [
    '# Ralplan: critic gate',
    '',
    modeBlock(mode),
    '',
    'Evaluate the fixed plan snapshot below independently. You have NOT been',
    'given the Architect review on purpose. Run the full protocol from your',
    'instructions: pre-commitment, verification of every reference against',
    'the codebase, assumptions, pre-mortem, dependency audit, ambiguity scan,',
    'feasibility, rollback, the four ralplan gates, executor/stakeholder/',
    'skeptic perspectives, gap analysis, self-audit and realist check.',
    mode === 'deliberate'
      ? 'DELIBERATE mode: the deliberateAdditions gate must fail on a missing or weak pre-mortem or test plan.'
      : 'SHORT mode: report the deliberateAdditions gate as pass with reason "not required".',
    'Return the structured JSON verdict with every field populated.',
    '',
    '## Original task',
    task,
    '',
    '## Plan snapshot',
    plan,
  ].join('\n');
