import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addReviewStory,
  amendCriterion,
  checkDraft,
  normalizePrd,
  prdFromDraft,
  prdStatus,
  type Prd,
  type Story,
} from '../src/ralph/prd.ts';

const draft = () => ({
  description: 'd',
  verify: ['npm test'],
  stories: [
    {
      id: 'US-001',
      title: 'a',
      description: 'da',
      acceptanceCriteria: ['f() returns 1'],
    },
    {
      id: 'US-002',
      title: 'b',
      description: 'db',
      acceptanceCriteria: ['test/b.test.ts passes'],
    },
  ],
});

const prd = (): Prd =>
  prdFromDraft(draft(), { project: 'p', branchName: 'main' });

test('checkDraft rejects generic criteria, empty stories, duplicate ids', () => {
  assert.deepEqual(checkDraft(draft()), []);
  const bad = draft();
  bad.stories[0].acceptanceCriteria = ['Implementation is complete'];
  bad.stories[1].id = 'US-001';
  bad.stories.push({
    id: 'US-003',
    title: 'c',
    description: 'dc',
    acceptanceCriteria: [],
  });
  const problems = checkDraft(bad);
  assert.ok(problems.some((p) => p.includes('generic criterion')));
  assert.ok(problems.some((p) => p.includes('duplicate story id')));
  assert.ok(problems.some((p) => p.includes('US-003: no acceptance')));
});

test('prdStatus picks the highest-priority pending story', () => {
  const p = prd();
  let status = prdStatus(p);
  assert.equal(status.next?.id, 'US-001');
  assert.equal(status.allPass, false);
  p.userStories[0].passes = true;
  status = prdStatus(p);
  assert.equal(status.next?.id, 'US-002');
  assert.equal(status.passed, 1);
  p.userStories[1].passes = true;
  status = prdStatus(p);
  assert.equal(status.allPass, true);
  assert.equal(status.allVerified, false);
  assert.equal(status.next, null);
});

test('amendCriterion: closed errors, ledger keeps the original, resets passes', () => {
  const story: Story = { ...prd().userStories[0], passes: true };
  const base = { kind: 'replaced' as const, reason: 'count was wrong' };
  assert.equal(
    amendCriterion(
      story,
      {
        ...base,
        original: 'nope',
        replacement: 'x',
        evidence: 'enumerated 12 not 16',
      },
      'a',
    ),
    'original-not-active',
  );
  assert.equal(
    amendCriterion(
      story,
      {
        ...base,
        original: 'f() returns 1',
        replacement: 'x',
        evidence: 'short',
      },
      'a',
    ),
    'evidence-too-short',
  );
  assert.equal(
    amendCriterion(
      story,
      { ...base, original: 'f() returns 1', evidence: 'enumerated 12 not 16' },
      'a',
    ),
    'replacement-required',
  );
  assert.equal(
    amendCriterion(
      story,
      {
        kind: 'superseded',
        original: 'f() returns 1',
        replacement: 'x',
        reason: 'r',
        evidence: 'enumerated 12 not 16',
      },
      'a',
    ),
    'replacement-not-allowed',
  );
  assert.equal(
    amendCriterion(
      story,
      {
        ...base,
        original: 'f() returns 1',
        replacement: 'f() returns 2',
        evidence: 'enumerated 12 not 16',
      },
      'ralph:run',
      '2026-01-01T00:00:00.000Z',
    ),
    null,
  );
  assert.deepEqual(story.acceptanceCriteria, ['f() returns 2']);
  assert.equal(story.passes, false);
  assert.equal(story.criterionAmendments[0].original, 'f() returns 1');
  assert.equal(story.criterionAmendments[0].authority, 'ralph:run');
  // an original can be amended only once
  story.acceptanceCriteria.push('f() returns 1');
  assert.equal(
    amendCriterion(
      story,
      {
        ...base,
        original: 'f() returns 1',
        replacement: 'y',
        evidence: 'enumerated 12 not 16',
      },
      'a',
    ),
    'original-not-active',
  );
});

test('normalizePrd fails closed on a contradictory ledger', () => {
  const p = prd();
  assert.ok(normalizePrd(JSON.parse(JSON.stringify(p))));
  const story = p.userStories[0];
  story.criterionAmendments.push({
    kind: 'superseded',
    original: 'f() returns 1', // still active -> invalid
    reason: 'r',
    evidence: 'enumerated 12 not 16',
    authority: 'a',
    timestamp: 't',
  });
  assert.equal(normalizePrd(JSON.parse(JSON.stringify(p))), null);
  assert.equal(normalizePrd({ project: 'x' }), null);
});

test('addReviewStory appends with the next priority', () => {
  const p = prd();
  const story = addReviewStory(p, 2, ['fix the null check in a.ts']);
  assert.equal(story.id, 'RV-002');
  assert.equal(story.priority, 3);
  assert.equal(prdStatus(p).pending.at(-1)?.id, 'RV-002');
});
