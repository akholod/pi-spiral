import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCriterionEntry, type Prd } from '../src/ralph/prd.ts';
import { normalizeReview } from '../src/ralph/loop.ts';
import type { ReviewReport } from '../src/ralph/types.ts';

const criteria = [
  '`math.js` exports a named function `add` that returns `a + b`.',
  'Calling `add(2, 3)` returns `5`.',
];

test('findCriterionEntry: by index first, then normalized text', () => {
  const entries = [
    { index: 2, criterion: 'add(2,3) gives five' },
    { criterion: 'math.js exports a named function add that returns a + b' },
  ];
  assert.equal(findCriterionEntry(entries, criteria, 1), entries[0]);
  assert.equal(findCriterionEntry(entries, criteria, 0), entries[1]);
  assert.equal(
    findCriterionEntry([{ criterion: 'other' }], criteria, 0),
    undefined,
  );
});

test('findCriterionEntry: text beats a wrong number, strongest duplicate wins', () => {
  const entries = [
    { index: 2, criterion: criteria[0], evidence: 'long enough evidence' },
    { index: 1, criterion: criteria[1], evidence: 'ok' },
  ];
  assert.equal(findCriterionEntry(entries, criteria, 0), entries[0]);
  assert.equal(findCriterionEntry(entries, criteria, 1), entries[1]);
  const twice = [
    { index: 1, criterion: criteria[0], evidence: 'x' },
    { index: 1, criterion: criteria[0], evidence: 'a real measurement' },
  ];
  assert.equal(findCriterionEntry(twice, criteria, 0), twice[1]);
});

// Captured live: gpt-6-luna verified every criterion but paraphrased them,
// and exact-text matching downgraded the APPROVE.
test('paraphrased criteria with index keep an APPROVE', () => {
  const prd = {
    userStories: [{ id: 'US-001', acceptanceCriteria: criteria }],
  } as unknown as Prd;
  const evidence = 'math.js:2 declares the export; add.test.js:6 asserts it';
  const review: ReviewReport = {
    verdict: 'APPROVE',
    summary: 'ok',
    criteria: [
      {
        storyId: 'US-001',
        index: 1,
        criterion: 'math.js exports named add(a, b) returning a + b.',
        status: 'VERIFIED',
        evidence,
      },
      {
        storyId: 'US-001',
        index: 2,
        criterion: 'Calling add(2, 3) returns 5.',
        status: 'VERIFIED',
        evidence,
      },
    ],
    findings: [],
    optimality: 'fine',
    filesReviewed: ['math.js'],
  };
  assert.equal(normalizeReview(prd, review).verdict, 'APPROVE');
  const missing = { ...review, criteria: review.criteria.slice(0, 1) };
  assert.equal(normalizeReview(prd, missing).verdict, 'REJECT');
});
