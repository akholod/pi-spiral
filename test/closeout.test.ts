import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendNotes,
  closeoutLines,
  closeoutNotes,
  incidentLine,
  type CloseoutInput,
} from '../src/ralph/closeout.ts';
import type { Prd } from '../src/ralph/prd.ts';
import type { RunState } from '../src/ralph/state.ts';
import type { ReviewReport } from '../src/ralph/types.ts';

const RUN_ID = '12345678-1234-1234-1234-123456789abc';
const NOW = new Date('2026-10-12T10:00:00Z');

const story = (id: string, attempts: number): Prd['userStories'][number] => ({
  id,
  title: id,
  description: 'd',
  acceptanceCriteria: ['c'],
  criterionAmendments: [],
  priority: 1,
  passes: true,
  reviewerVerified: true,
  attempts,
  notes: [],
});

const prdOf = (...attempts: number[]): Prd => ({
  project: 'p',
  branchName: 'b',
  description: '',
  repoQualityClass: 'production',
  verify: [],
  userStories: attempts.map((n, i) => story(`US-00${i + 1}`, n)),
});

const stateOf = (extra: Partial<RunState> = {}): RunState => ({
  runId: RUN_ID,
  task: 't',
  startedAt: NOW.toISOString(),
  reviewerAgent: 'critic',
  deslop: true,
  outcome: 'completed',
  phase: 'done',
  iterations: 2,
  reviewRounds: 1,
  verifyCommands: ['true'],
  verification: 'passed',
  feedbackBaseline: null,
  baselineWarnings: [],
  cleanupDone: true,
  changedFiles: [],
  gitBaseline: [],
  gitHead: null,
  patterns: [],
  entries: [],
  reviews: [],
  tokensSpent: 0,
  ...extra,
});

const reject = (summary: string): ReviewReport => ({
  verdict: 'REJECT',
  summary,
  criteria: [],
  findings: [],
  optimality: '',
  filesReviewed: [],
});

const input = (extra: Partial<CloseoutInput> = {}): CloseoutInput => ({
  outcome: 'completed',
  runId: RUN_ID,
  runDir: '/state/p/run',
  prd: prdOf(1, 1),
  state: stateOf(),
  now: NOW,
  ...extra,
});

test('a clean completed run writes nothing', () => {
  assert.deepEqual(closeoutLines(input()), []);
  assert.deepEqual(closeoutNotes(input()), { problems: [], issues: [] });
});

test('a completed run with retries and a rejection yields factual lines', () => {
  const lines = closeoutLines(
    input({
      prd: prdOf(3, 1, 2),
      state: stateOf({ reviews: [reject('missing tests')] }),
    }),
  );
  assert.deepEqual(lines, [
    '- 2026-10-12 12345678 completed: reviewer rejected 1 time(s); last: ' +
      'missing tests',
    '- 2026-10-12 12345678 completed: retries: US-001 x3, US-003 x2',
  ]);
});

test('three-strike block: problem line plus incident, no blocker line', () => {
  const blockers = 'US-001 failed 3 attempts: criteria not met';
  const state = stateOf({
    outcome: 'blocked',
    blockers,
    haltKind: 'three-strike',
    entries: [
      {
        timestamp: 't',
        storyId: 'US-001',
        attempt: 3,
        outcome: 'failed',
        summary: 's',
        filesChanged: [],
        learnings: [],
      },
    ],
  });
  const i = input({
    outcome: 'blocked',
    state,
    prd: prdOf(3),
    failingCommands: ['npm test'],
  });
  assert.equal(
    closeoutLines(i)[0],
    `- 2026-10-12 12345678 blocked: US-001 after 3 attempt(s): ${blockers}`,
  );
  const notes = closeoutNotes(i);
  assert.equal(notes.issues.length, 1);
  assert.equal(
    notes.issues[0],
    `- 2026-10-12 12345678 INCIDENT ${blockers} | evidence: ` +
      '/state/p/run/run.json, /state/p/run/progress.md, ' +
      `last verify: npm test | reopen: /ralph --resume ${RUN_ID}`,
  );
});

test('user-input block: issues line only, no incident', () => {
  const i = input({
    outcome: 'blocked',
    state: stateOf({
      outcome: 'blocked',
      blockers: 'which database?',
      haltKind: 'user-input',
    }),
  });
  assert.equal(incidentLine(i), null);
  const notes = closeoutNotes(i);
  assert.deepEqual(notes.issues, [
    '- 2026-10-12 12345678 blocked: which database? | ' +
      `reopen: /ralph --resume ${RUN_ID}`,
  ]);
});

test('failed post-cleanup verification is an incident', () => {
  const i = input({
    outcome: 'failed',
    error: 'post-cleanup regression commands still fail',
    state: stateOf({ outcome: 'failed', haltKind: 'verify' }),
    failingCommands: ['npm test', 'npm run lint'],
  });
  assert.match(
    closeoutLines(i)[0],
    /failed: post-cleanup regression commands still fail$/,
  );
  assert.match(
    incidentLine(i) ?? '',
    /INCIDENT post-cleanup .* last verify: npm test, npm run lint \|/,
  );
  // a failure without a halt kind (a role error) is no incident
  const other = input({
    outcome: 'failed',
    error: 'boom',
    state: stateOf({ outcome: 'failed' }),
  });
  assert.equal(incidentLine(other), null);
});

test('aborted run writes lines only for what applies', () => {
  assert.deepEqual(
    closeoutLines(
      input({ outcome: 'aborted', state: stateOf({ outcome: 'aborted' }) }),
    ),
    [],
  );
  const lines = closeoutLines(
    input({
      outcome: 'aborted',
      prd: prdOf(2),
      state: stateOf({ outcome: 'aborted' }),
    }),
  );
  assert.deepEqual(lines, [
    '- 2026-10-12 12345678 aborted: retries: US-001 x2',
  ]);
});

test('budget stop leads with the budget line', () => {
  const lines = closeoutLines(
    input({
      outcome: 'exhausted',
      prd: prdOf(2),
      state: stateOf({ outcome: 'exhausted', tokensSpent: 95 }),
      budget: { spent: 95, limit: 100 },
    }),
  );
  assert.equal(
    lines[0],
    '- 2026-10-12 12345678 exhausted: stopped by token budget: 95/100 tokens',
  );
  assert.equal(lines.length, 2);
});

test('at most three lines, long text is cut', () => {
  const long = 'x'.repeat(500);
  const lines = closeoutLines(
    input({
      outcome: 'blocked',
      prd: prdOf(3),
      budget: { spent: 1, limit: 1 },
      state: stateOf({
        outcome: 'blocked',
        blockers: long,
        verification: 'none',
        reviews: [reject(long)],
        baselineWarnings: ['FAIL a'],
      }),
    }),
  );
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.length < 300));
  assert.match(lines[1], /\.\.\.$/);
});

test('appendNotes appends across runs and writes nothing when empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spiral-notes-'));
  const empty = appendNotes(dir, { problems: [], issues: [] });
  assert.deepEqual(empty, { problems: 0, issues: 0, dir: join(dir, 'notes') });
  assert.equal(existsSync(join(dir, 'notes')), false);

  appendNotes(dir, { problems: ['- first'], issues: ['- issue one'] });
  appendNotes(dir, { problems: ['- second', '- third'], issues: [] });
  assert.equal(
    readFileSync(join(dir, 'notes', 'problems.md'), 'utf8'),
    '- first\n- second\n- third\n',
  );
  assert.equal(
    readFileSync(join(dir, 'notes', 'issues.md'), 'utf8'),
    '- issue one\n',
  );
});
