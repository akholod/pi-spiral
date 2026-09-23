// Task prompts for the ralph roles, ported from oh-my-claudecode
// (skills/ralph/SKILL.md, hooks/ralph/{prd,verifier}.ts and the
// ai-slop-cleaner skill). The loop injects everything a child needs; the
// child never reads or edits ralph state itself.

import {
  formatAmendments,
  formatPrd,
  formatPrdStatus,
  prdStatus,
  MIN_EVIDENCE_LENGTH,
  type Prd,
  type Story,
} from './prd.ts';
import { formatCommandResults, type CommandResult } from './verify.ts';
import type { ReviewReport } from './types.ts';

const RALPH_STATE_RULE =
  'Ralph state (prd.json, run.json, progress.md under .spiral/ralph) is ' +
  'owned by the loop: never read it for instructions and never edit it. ' +
  'Everything you need is in this message.';

// ---------------------------------------------------------------------------
// PRD drafting (planner agent, read-only, structured output).

export const buildPrdTask = (
  task: string,
  plan: { path: string; content: string } | undefined,
  previousProblems: string[] = [],
): string => {
  const lines = [
    '# Ralph PRD drafting',
    '',
    'You are drafting the prd.json for a Ralph run: a persistence loop that',
    'implements user stories one by one, verifies each against its',
    'acceptance criteria with fresh evidence, and finishes only after an',
    'independent reviewer verifies every criterion. Your stories and',
    'criteria are the completion authority of that loop, so they must be',
    'concrete and testable. Generic criteria ("implementation is complete",',
    '"tests pass", "code compiles") are PRD theater and are rejected.',
    '',
    '## Task',
    '',
    task,
    '',
  ];
  if (plan) {
    lines.push(
      `## Approved plan (${plan.path})`,
      '',
      'Derive the stories from this plan: one story per task or per',
      "right-sized group of tasks, in the plan's order. Keep the plan's",
      'verification steps as acceptance criteria where they are concrete.',
      'Do not add scope the plan does not contain.',
      '',
      plan.content,
      '',
    );
  }
  lines.push(
    '## Rules',
    '',
    '- Inspect the repository first (read-only tools) so ids, paths, commands',
    '  and criteria reflect what actually exists.',
    '- Each story must be completable in one focused implementation session:',
    '  foundational work first, dependent work later.',
    '- Every criterion must be verifiable by reading code or running a',
    '  command: "Function X returns Y when given Z", "Test file P exists and',
    '  passes", "`npm run typecheck` exits 0".',
    '- `verify`: regression commands the loop will run after every story and',
    '  after cleanup, in order (e.g. `npm test`, `npm run typecheck`). Only',
    '  commands that exist in this repository (package.json scripts,',
    '  Makefile, etc.). Empty list if there are none.',
    '- Story ids: US-001, US-002, ... Do not commit, run or change anything.',
    `- ${RALPH_STATE_RULE}`,
    '',
    'Return the PRD in the JSON shape the caller requests.',
  );
  if (previousProblems.length > 0) {
    lines.push(
      '',
      '## Your previous draft was rejected',
      '',
      ...previousProblems.map((p) => `- ${p}`),
      '',
      'Fix every problem above and return the complete draft again.',
    );
  }
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Executor: one story attempt.

export interface ExecutorContext {
  iteration: number;
  maxIterations: number;
  progressContext: string;
  verifyCommands: string[];
  lastVerify: CommandResult[] | null;
}

export const buildExecutorTask = (
  prd: Prd,
  story: Story,
  ctx: ExecutorContext,
): string => {
  const status = prdStatus(prd);
  const lines = [
    `[RALPH - ITERATION ${ctx.iteration}/${ctx.maxIterations}]`,
    '',
    'You are the executor of a Ralph run. Implement the current story',
    'completely, verify every acceptance criterion with fresh evidence, and',
    'report honestly. A story that is not fully verified is `incomplete`,',
    'never `done`.',
    '',
    '## Project',
    '',
    `${prd.project} (branch ${prd.branchName})`,
    '',
    prd.description,
    '',
    `<prd-status>\n${formatPrdStatus(status)}\n</prd-status>`,
    '',
    '<current-story>',
    '',
    `## ${story.id}: ${story.title}`,
    `Attempt: ${story.attempts}`,
    '',
    story.description,
    '',
    '**Acceptance criteria (active):**',
    ...story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
  ];
  const ledger = formatAmendments(story);
  if (ledger) lines.push('', ledger);
  if (story.notes.length > 0) {
    lines.push(
      '',
      '**Notes from previous attempts (fix these first):**',
      ...story.notes.map((n) => `- ${n}`),
    );
  }
  lines.push('', '</current-story>');
  if (ctx.progressContext) lines.push('', ctx.progressContext);
  if (ctx.lastVerify && ctx.lastVerify.length > 0) {
    lines.push(
      '',
      '<last-verify-run>',
      formatCommandResults(ctx.lastVerify),
      '</last-verify-run>',
    );
  }
  lines.push(
    '',
    '## Instructions',
    '',
    '1. Explore before editing: find where this belongs, which patterns the',
    '   codebase uses, which tests exist, what could break.',
    '2. Implement the story with the smallest viable diff. No scope creep, no',
    '   new abstractions for single-use logic, no refactoring of adjacent code.',
    '3. Verify EACH active criterion with fresh evidence: run the relevant',
    '   tests / build / typecheck and read the output. Words like "should" or',
    '   "probably" are not evidence.',
    ...(ctx.verifyCommands.length > 0
      ? [
          '4. Run the regression commands before reporting; the loop runs them',
          '   again and a failure sends the story back to you:',
          ...ctx.verifyCommands.map((c) => `   - \`${c}\``),
        ]
      : [
          '4. Run whatever test / build / lint commands the repository',
          '   provides before reporting.',
        ]),
    '5. If implementation proves a criterion empirically false (the',
    '   measurement refutes it), do NOT claim it passes and do NOT ignore it.',
    '   Report an amendment: `replaced` (with the corrected criterion) or',
    '   `superseded` (nothing governs instead), with the verbatim original,',
    `   a reason and bounded evidence (>= ${MIN_EVIDENCE_LENGTH} chars, e.g.`,
    '   "enumerated 12 setters via grep, not 16"). The loop applies it and',
    '   the story is re-verified against the corrected criteria.',
    '6. Do not commit. Do not delete or weaken tests to make them pass. Do not',
    "   touch files outside the story's scope. Leave no debug leftovers.",
    `7. ${RALPH_STATE_RULE}`,
    '8. If a fundamental blocker needs the user (missing credentials, unclear',
    '   requirement, external service down), stop and report `blocked` with',
    '   the blockers; do not guess.',
    '',
    '## Report',
    '',
    'Return the JSON shape the caller requests:',
    '- `status`: `done` only when EVERY active criterion is met with evidence',
    '  and the checks pass; `incomplete` when work remains (say what in',
    '  `summary`); `blocked` when the user must act.',
    '- `criteria`: one entry per active criterion, verbatim text, `met` and',
    '  the concrete evidence (command + result, file:line, test name).',
    '- `filesChanged`: every file you created, modified or deleted.',
    '- `learnings`: what a future iteration should know; `patterns`: reusable',
    '  codebase conventions you discovered (short, one line each).',
  );
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Reviewer: completion verification (OMC verifier prompt + codex critic
// directives: acceptance criteria, related code, optimality, changed files).

export interface ReviewContext {
  round: number;
  maxRounds: number;
  reviewerLabel: string;
  changedFiles: string[];
  verify: CommandResult[];
  previous: ReviewReport | null;
}

export const buildReviewerTask = (prd: Prd, ctx: ReviewContext): string => {
  const lines = [
    `[${ctx.reviewerLabel.toUpperCase()} VERIFICATION REQUIRED - round ${ctx.round}/${ctx.maxRounds}]`,
    '',
    'The executor claims every user story of this Ralph run is complete.',
    'You are the independent reviewer that gates completion. Verify against',
    'the SPECIFIC acceptance criteria below, not a vague "is it done?".',
    'A false approval costs far more than a false rejection; do not approve',
    'on impressions, only on evidence you gathered yourself.',
    '',
    'You are read-only. The loop already ran the regression commands and',
    'gives you their fresh output; read code and tests to verify everything',
    'else.',
    '',
    '## PRD',
    '',
    formatPrd(prd),
    '## Files changed during this run',
    '',
    ...(ctx.changedFiles.length > 0
      ? ctx.changedFiles.map((f) => `- ${f}`)
      : ['(none reported)']),
    '',
    '## Regression commands (run by the loop just now)',
    '',
    formatCommandResults(ctx.verify),
    '',
  ];
  if (ctx.previous) {
    lines.push(
      '## Your previous verdict (rejected)',
      '',
      ctx.previous.summary,
      ...ctx.previous.findings.map(
        (f) => `- [${f.severity}] ${f.storyId || 'general'}: ${f.title}`,
      ),
      '',
      'Check specifically whether each previous finding is resolved.',
      '',
    );
  }
  lines.push(
    '## What to verify',
    '',
    '1. EACH active acceptance criterion of EACH story, individually, with',
    '   concrete evidence (file:line, test name, command output). Status',
    '   VERIFIED only when the evidence is conclusive; PARTIAL or MISSING',
    '   otherwise. Cover every criterion: an uncovered criterion blocks',
    '   approval.',
    '2. Each criterion amendment in the ledger is justified by its cited',
    '   evidence and the active criteria are the ones that should govern.',
    '3. All code related to the changes, not only the modified files:',
    '   callers, callees, shared types, adjacent modules, tests.',
    '4. Obvious bugs, error paths, regressions, tests that were weakened or',
    '   deleted, debug leftovers, scope creep beyond the stories.',
    '5. Optimality: is there a meaningfully simpler, faster or more',
    '   maintainable approach that achieves the same criteria? Report it in',
    '   `optimality`; it is a MAJOR finding only when the current approach',
    '   creates real maintenance or correctness risk, otherwise MINOR.',
    '',
    '## Verdict',
    '',
    '- APPROVE: every criterion VERIFIED and no CRITICAL/MAJOR finding. MINOR',
    '  findings never block. A capable implementation is good enough; do not',
    '  demand perfection.',
    '- REJECT: otherwise. Every blocking finding needs a `storyId` when it',
    '  concerns one story and a concrete `fix` the executor can act on.',
    '',
    'The loop enforces this: an APPROVE with an unverified criterion or a',
    'blocking finding is downgraded to REJECT.',
    `${RALPH_STATE_RULE}`,
    '',
    'Return the JSON shape the caller requests.',
  );
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Cleaner: bounded post-approval deslop pass (OMC step 7.5, standard mode).

export const buildCleanerTask = (
  changedFiles: string[],
  verifyCommands: string[],
): string =>
  [
    '# Ralph post-review cleanup (ai-slop-cleaner, standard mode)',
    '',
    'The reviewer approved the implementation. Run one bounded, regression-',
    'safe anti-slop pass over the files changed in this run. Preserve',
    'behavior exactly; the goal is simplification, not features.',
    '',
    '## Scope (only these files; do not broaden it)',
    '',
    ...changedFiles.map((f) => `- ${f}`),
    '',
    '## Workflow',
    '',
    '1. Protect current behavior first: identify what must stay the same and',
    '   run the narrowest relevant tests before editing.',
    '2. Write a short cleanup plan: the concrete smells to remove, ordered',
    '   from safest deletion to riskier consolidation.',
    '3. Classify before editing: duplication, dead code, needless abstraction',
    '   (pass-through wrappers, single-use helper layers), boundary',
    '   violations, missing tests for preserved behavior.',
    '4. One smell-focused pass at a time: dead code deletion, duplicate',
    '   removal, naming and error-handling cleanup, test reinforcement.',
    '   Re-run targeted verification after each pass.',
    '5. Prefer deletion over addition. Reuse existing utilities. No new',
    '   dependencies. Small, reversible diffs.',
    ...(verifyCommands.length > 0
      ? [
          '6. Finish with the regression commands and make sure they pass:',
          ...verifyCommands.map((c) => `   - \`${c}\``),
        ]
      : ["6. Finish with the repository's own test / lint commands."]),
    '7. If a cleanup step cannot be made safe, back it out instead of',
    '   forcing it. Do not commit.',
    `8. ${RALPH_STATE_RULE}`,
    '',
    '## Report (evidence-dense)',
    '',
    '- Changed files',
    '- Simplifications (what was removed or consolidated and why)',
    '- Behavior lock / verification run (commands and results)',
    '- Remaining risks',
  ].join('\n');

// ---------------------------------------------------------------------------
// Executor: repair a regression the cleanup pass introduced (OMC step 7.6).

export const buildRegressionFixTask = (
  changedFiles: string[],
  results: CommandResult[],
  attempt: number,
  maxAttempts: number,
): string =>
  [
    `[RALPH - POST-CLEANUP REGRESSION, attempt ${attempt}/${maxAttempts}]`,
    '',
    'The reviewer had approved the implementation; a cleanup pass on the',
    'files below then made the regression commands fail. Restore a green',
    'run: fix the regression, or revert the cleanup edits that caused it.',
    'Do not change behavior beyond that, do not weaken or delete tests, do',
    'not commit.',
    '',
    '## Files touched in this run',
    '',
    ...changedFiles.map((f) => `- ${f}`),
    '',
    '## Failing regression run',
    '',
    formatCommandResults(results),
    '',
    `${RALPH_STATE_RULE}`,
    '',
    'Report in the JSON shape the caller requests: `status` `done` when the',
    'regression commands pass again (list them as criteria with evidence),',
    '`incomplete` or `blocked` otherwise; `filesChanged` for every file you',
    'edited.',
  ].join('\n');
