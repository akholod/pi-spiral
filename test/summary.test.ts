import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  architectSummary,
  changelogItem,
  clip,
  countSteps,
  criticSummary,
  plannerSummary,
  progressEntry,
  renderProgressText,
  withProgressSummary,
} from '../src/ralplan/summary.ts';
import { normalizeReview } from '../src/ralplan/loop.ts';
import type { CriticReview } from '../src/ralplan/types.ts';
import {
  baselineSummary,
  cleanerSummary,
  executorSummary,
  prdSummary,
  reviewerSummary,
  verifySummary,
} from '../src/ralph/summary.ts';
import { diffBaseline, fingerprintAll } from '../src/ralph/baseline.ts';
import type { ReviewReport } from '../src/ralph/types.ts';

const PLAN_V1 = `# Add retry with backoff to the HTTP client

## Requirements summary
Calls to the billing API fail on 503.

## Implementation steps
1. **Add backoff helper** - src/http/backoff.ts
2. **Wire into client** - src/http/client.ts
3. **Tests** - test/http.test.ts

## Acceptance criteria
- a 503 is retried 3 times
`;

const PLAN_V2 = `${PLAN_V1}
## Changelog
- Applied critic MAJOR: jitter must be bounded; added a cap to step 1.
- Declined architect antithesis (queue-based retry): out of scope.
`;

const finding = (
  severity: CriticReview['findings'][number]['severity'],
  title: string,
): CriticReview['findings'][number] => ({
  severity,
  title,
  evidence: 'e',
  why: 'because',
  fix: 'f',
  confidence: 'HIGH',
});

const criticReview = (
  verdict: CriticReview['verdict'],
  findings: CriticReview['findings'],
  summary = 'summary',
): CriticReview => {
  const gate = { pass: true, reason: 'ok' };
  return {
    verdict,
    mode: 'THOROUGH',
    summary,
    preCommitment: 'p',
    findings,
    gaps: [],
    ambiguities: [],
    perspectives: { executor: 'x', stakeholder: 's', skeptic: 'k' },
    gates: {
      principleOptionConsistency: gate,
      alternativesDepth: gate,
      riskVerificationRigor: gate,
      deliberateAdditions: gate,
    },
    justification: 'j',
    openQuestions: [],
  };
};

test('clip collapses whitespace and adds an ellipsis', () => {
  assert.equal(clip('a\n  b\t c'), 'a b c');
  assert.equal(clip('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
  assert.equal(clip('short', 10), 'short');
});

test('planner: headline and step count in round 1', () => {
  assert.deepEqual(plannerSummary(PLAN_V1, 1), [
    'Add retry with backoff to the HTTP client (3 steps)',
  ]);
  assert.equal(countSteps('no sections here'), null);
});

test('planner: later rounds report the changelog head', () => {
  assert.equal(
    changelogItem(PLAN_V2),
    'Applied critic MAJOR: jitter must be bounded; added a cap to step 1.',
  );
  const lines = plannerSummary(PLAN_V2, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^revised from feedback: Applied critic MAJOR/);
  // no changelog: generic note, never an empty line
  assert.deepEqual(
    plannerSummary(PLAN_V1, 2)[1],
    'revised from architect/critic feedback',
  );
});

test('planner: plain text plan falls back to the first line', () => {
  assert.deepEqual(plannerSummary('\n\nDo X then Y.\nMore.', 1), [
    'Do X then Y.',
  ]);
});

test('architect: prefers the antithesis over boilerplate and headings', () => {
  const review = [
    "Here's my review of the plan.",
    '',
    '## Summary',
    'The plan is mostly sound.',
    '',
    '## Consensus addendum',
    '- **Antithesis (steelman):** a queue-based retry avoids blocking callers',
    '  and survives restarts, which in-process backoff cannot.',
    '- **Tradeoff tension:** simplicity vs durability',
  ].join('\n');
  assert.deepEqual(architectSummary(review), [
    'Antithesis (steelman): a queue-based retry avoids blocking callers',
  ]);
});

test('architect: without antithesis, first non-boilerplate prose line', () => {
  assert.deepEqual(
    architectSummary(
      'Sure, here is the review.\n\n## Summary\nSteps 2 and 3 are coupled.',
    ),
    ['Steps 2 and 3 are coupled.'],
  );
  assert.deepEqual(architectSummary('## Only a heading'), []);
});

test('critic: counts, verdict and top blocking findings', () => {
  const lines = criticSummary(
    criticReview('ITERATE', [
      finding('MINOR', 'naming'),
      finding('MAJOR', 'no rollback for the migration'),
      finding('CRITICAL', 'step 2 edits a file that does not exist'),
      finding('MAJOR', 'tests only cover the happy path'),
    ]),
  );
  assert.deepEqual(lines, [
    'ITERATE — 1 CRITICAL, 2 MAJOR, 1 MINOR',
    'CRITICAL: step 2 edits a file that does not exist',
    'MAJOR: no rollback for the migration',
  ]);
});

test('critic: APPROVE downgraded by normalizeReview is called out', () => {
  const normalized = normalizeReview(
    criticReview('APPROVE', [finding('MAJOR', 'missing rollback')]),
  );
  const lines = criticSummary(normalized);
  assert.equal(lines[0], 'ITERATE — 0 CRITICAL, 1 MAJOR, 0 MINOR');
  assert.equal(
    lines[1],
    'APPROVE downgraded to ITERATE: 1 blocking finding(s)',
  );
  assert.equal(lines[2], 'MAJOR: missing rollback');
  assert.ok(lines.length <= 3);
  // a clean approve has just the header
  assert.deepEqual(criticSummary(criticReview('APPROVE', [])), [
    'APPROVE — 0 CRITICAL, 0 MAJOR, 0 MINOR',
  ]);
});

test('prd: id and clipped titles, at most two lines', () => {
  assert.deepEqual(
    prdSummary([
      { id: 'US-001', title: 'add parser' },
      { id: 'US-002', title: 'wire the parser into the CLI' },
    ]),
    ['2 stories: US-001 add parser, US-002 wire the parser into the CLI'],
  );
  assert.deepEqual(prdSummary([{ id: 'US-001', title: 'only' }]), [
    '1 story: US-001 only',
  ]);
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `US-${String(i + 1).padStart(3, '0')}`,
    title: 'implement a moderately long story title here',
  }));
  const lines = prdSummary(many);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.length <= 160));
  assert.match(lines[1], /\(\+\d+ more\)/);
});

test('executor: pass, retry and blocked with file names', () => {
  const base = {
    storyId: 'US-002',
    attempt: 1,
    maxAttempts: 3,
    report: 'Added the parser\nwith tests',
    filesChanged: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
  };
  assert.deepEqual(executorSummary({ ...base, outcome: 'pass' }), [
    'US-002 pass',
    'Added the parser with tests',
    '4 files changed: src/a.ts, src/b.ts, src/c.ts, …',
  ]);
  assert.equal(
    executorSummary({
      ...base,
      outcome: 'retry',
      attempt: 2,
      problem: 'criteria not met or not reported: f() returns 1',
    })[0],
    'US-002 retry 2/3: criteria not met or not reported: f() returns 1',
  );
  assert.equal(
    executorSummary({
      ...base,
      outcome: 'blocked',
      filesChanged: [],
      problem: 'needs API key',
    }).at(-1),
    'no files changed',
  );
});

test('verify: new failures with first signature plus baseline warning', () => {
  const baseline = fingerprintAll([
    {
      command: 'npm test',
      ok: false,
      exitCode: 1,
      output: 'not ok 1 - old flaky test',
    },
  ]);
  const current = fingerprintAll([
    {
      command: 'npm test',
      ok: false,
      exitCode: 1,
      output:
        'not ok 1 - old flaky test\nnot ok 2 - parser rejects empty input',
    },
  ]);
  const diff = diffBaseline(baseline, current, []);
  const lines = verifySummary(diff);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^1 new failure: npm test: .*parser rejects empty/);
  assert.equal(lines[1], 'warning: 1 pre-existing failure still present');
  assert.deepEqual(verifySummary({ newFailures: [], baselineFailures: [] }), [
    'no new failures',
  ]);
  assert.deepEqual(baselineSummary([]), ['baseline clean']);
});

test('reviewer: reject names reopened/added stories and first blocker', () => {
  const report: ReviewReport = {
    verdict: 'REJECT',
    summary: 'two criteria unverified',
    criteria: [],
    findings: [
      {
        severity: 'MINOR',
        storyId: 'US-001',
        title: 'typo',
        evidence: 'e',
        fix: 'f',
      },
      {
        severity: 'MAJOR',
        storyId: 'US-002',
        title: 'empty input crashes the parser',
        evidence: 'e',
        fix: 'f',
      },
    ],
    optimality: 'fine',
    filesReviewed: [],
  };
  assert.deepEqual(
    reviewerSummary({
      report,
      reopened: ['US-002', 'RV-001'],
      added: ['RV-001'],
    }),
    [
      'REJECT — reopened US-002; added RV-001',
      'MAJOR (US-002): empty input crashes the parser',
    ],
  );
  assert.deepEqual(
    reviewerSummary({
      report: { ...report, verdict: 'APPROVE', summary: 'all verified' },
      reopened: [],
      added: [],
    }),
    ['APPROVE — all verified'],
  );
});

test('cleaner: scope, report and regression repair', () => {
  assert.deepEqual(
    cleanerSummary({
      report: '## Cleanup\nRemoved two dead helpers',
      scopeFiles: 4,
      repairs: 1,
      ok: true,
    }),
    [
      'cleanup scoped to 4 files',
      'Cleanup',
      'regression repaired after 1 fix attempt',
    ],
  );
});

test('rendered notification: header plus indented digest lines', () => {
  const critic = normalizeReview(
    criticReview('APPROVE', [finding('MAJOR', 'missing rollback')]),
  );
  const text = withProgressSummary(
    '[ralplan] iteration 2: critic finished (completed)',
    criticSummary(critic),
  );
  assert.equal(
    text,
    [
      '[ralplan] iteration 2: critic finished (completed)',
      '  ITERATE — 0 CRITICAL, 1 MAJOR, 0 MINOR',
      '  APPROVE downgraded to ITERATE: 1 blocking finding(s)',
      '  MAJOR: missing rollback',
    ].join('\n'),
  );
  assert.equal(
    withProgressSummary('[ralplan] iteration 1: planner started'),
    '[ralplan] iteration 1: planner started',
  );
  console.log(text);
  console.log(
    withProgressSummary(
      '[ralph] iteration 2: executor finished (completed)',
      executorSummary({
        storyId: 'US-002',
        outcome: 'retry',
        attempt: 1,
        maxAttempts: 3,
        report: 'parser added, empty input still crashes',
        filesChanged: ['src/parser.ts', 'test/parser.test.ts'],
        problem: 'regression commands failed (new): npm test: not ok 2',
      }),
    ),
  );
});

test('progress entry payload and rendering', () => {
  const text = withProgressSummary(
    '[ralplan] iteration 1: critic finished (completed)',
    ['ITERATE — 0 CRITICAL, 1 MAJOR, 0 MINOR', 'MAJOR: missing rollback'],
  );
  const ok = progressEntry(text, 'completed');
  assert.deepEqual(ok, { text, level: 'info' });
  assert.equal(progressEntry(text, 'failed').level, 'error');
  assert.equal(progressEntry(text, 'timeout').level, 'error');
  assert.equal(progressEntry(text).level, 'info');
  const fg = (color: string, t: string) => `<${color}>${t}</${color}>`;
  assert.equal(
    renderProgressText(ok, fg),
    [
      '<muted>[ralplan] iteration 1: critic finished (completed)</muted>',
      '  ITERATE — 0 CRITICAL, 1 MAJOR, 0 MINOR',
      '  MAJOR: missing rollback',
    ].join('\n'),
  );
  assert.match(
    renderProgressText(progressEntry(text, 'failed'), fg),
    /^<error>\[ralplan\]/,
  );
});
