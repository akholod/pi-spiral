import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile as compile } from 'typebox/compile';
import {
  PRD_DRAFT_SCHEMA,
  REPO_QUALITY_CLASSES,
  addReviewStory,
  amendCriterion,
  checkDraft,
  formatPrd,
  markStoryFailed,
  markStoryPassed,
  normalizePrd,
  prdFromDraft,
  prdStatus,
  type Prd,
  type RepoQualityClass,
} from '../src/ralph/prd.ts';
import {
  buildCleanerTask,
  buildExecutorTask,
  buildPrdTask,
  buildReviewerTask,
  qualityClassLine,
} from '../src/ralph/prompts.ts';
import { PRD_FILE, RunStore } from '../src/ralph/state.ts';

const draft = (cls: RepoQualityClass = 'library') => ({
  description: 'd',
  repoQualityClass: cls,
  verify: [],
  stories: ['US-001', 'US-002'].map((id) => ({
    id,
    title: id,
    description: `do ${id}`,
    acceptanceCriteria: [`${id} works`, `${id} is tested`],
  })),
});

const makePrd = (cls: RepoQualityClass = 'library'): Prd =>
  prdFromDraft(draft(cls), { project: 'p', branchName: 'main' });

const state = (): never =>
  ({
    runId: 'r',
    task: 't',
    startedAt: 'now',
    reviewerAgent: 'x',
    deslop: false,
    outcome: 'running',
    phase: 'stories',
    iterations: 0,
    reviewRounds: 0,
    verifyCommands: [],
    verification: 'none',
    feedbackBaseline: null,
    baselineWarnings: [],
    cleanupDone: false,
    changedFiles: [],
    gitBaseline: [],
    gitHead: null,
    patterns: [],
    entries: [],
    reviews: [],
  }) as never;

test('draft schema accepts the three classes, rejects others', () => {
  const checker = compile(PRD_DRAFT_SCHEMA);
  /* eslint-disable new-cap */
  for (const cls of REPO_QUALITY_CLASSES) {
    assert.ok(checker.Check(draft(cls)), cls);
  }
  assert.ok(!checker.Check({ ...draft(), repoQualityClass: 'enterprise' }));
  const { repoQualityClass: _omit, ...missing } = draft();
  assert.ok(!checker.Check(missing));
  /* eslint-enable new-cap */
  assert.deepEqual(checkDraft(draft('prototype')), []);
});

test('loader defaults missing or invalid class to production', () => {
  const raw = JSON.parse(JSON.stringify(makePrd('library')));
  assert.equal(normalizePrd(raw)?.repoQualityClass, 'library');
  delete raw.repoQualityClass;
  assert.equal(normalizePrd(raw)?.repoQualityClass, 'production');
  raw.repoQualityClass = 'bogus';
  assert.equal(normalizePrd(raw)?.repoQualityClass, 'production');
  raw.repoQualityClass = 7;
  assert.equal(normalizePrd(raw)?.repoQualityClass, 'production');
});

test('class survives draft, mutations, persist and reload', () => {
  const prd = makePrd('library');
  assert.equal(prd.repoQualityClass, 'library');
  const [first, second] = prd.userStories;
  markStoryPassed(first, 'ok');
  markStoryFailed(first, 'nope');
  assert.equal(
    amendCriterion(
      second,
      {
        kind: 'replaced',
        original: 'US-002 works',
        replacement: 'US-002 works well',
        reason: 'r',
        evidence: 'long enough evidence',
      },
      'loop',
    ),
    null,
  );
  addReviewStory(prd, 1, ['fix it']);
  const dir = mkdtempSync(join(tmpdir(), 'qc-'));
  const store = RunStore.create(dir);
  store.persist(prd, state());
  const { store: reopened } = RunStore.open(dir);
  const loaded = reopened.readPrd().prd;
  assert.equal(loaded?.repoQualityClass, 'library');
  assert.equal(loaded?.userStories.length, 3);
  // old prd.json without the field still resumes
  const legacy = JSON.parse(JSON.stringify(prd));
  delete legacy.repoQualityClass;
  writeFileSync(join(dir, PRD_FILE), JSON.stringify(legacy));
  assert.equal(
    RunStore.open(dir).store.readPrd().prd?.repoQualityClass,
    'production',
  );
});

test('formatPrd shows the quality class under Branch', () => {
  const lines = formatPrd(makePrd('prototype')).split('\n');
  const at = lines.indexOf('Branch: main');
  assert.equal(lines[at + 1], 'Quality class: prototype');
});

test('story selection stays earliest open story', () => {
  const prd = makePrd('library');
  assert.equal(prdStatus(prd).next?.id, 'US-001');
  markStoryPassed(prd.userStories[0], 'ok');
  assert.equal(prdStatus(prd).next?.id, 'US-002');
});

test('qualityClassLine differs per role and class', () => {
  const seen = new Set<string>();
  for (const role of ['executor', 'reviewer', 'cleaner'] as const) {
    for (const cls of REPO_QUALITY_CLASSES) {
      const line = qualityClassLine(role, cls);
      assert.match(line, new RegExp(`^Repo quality class: ${cls} - `));
      seen.add(line);
    }
  }
  assert.equal(seen.size, 9);
  assert.match(qualityClassLine('reviewer', 'library'), /MAJOR finding/);
  assert.match(qualityClassLine('executor', 'library'), /backward compatible/);
  assert.match(qualityClassLine('reviewer', 'prototype'), /do not reject/);
  assert.match(qualityClassLine('executor', 'production'), /full bar/);
});

test('role prompts carry the class line', () => {
  const prd = makePrd('library');
  const story = prd.userStories[0];
  const executor = buildExecutorTask(prd, story, {
    iteration: 1,
    maxIterations: 5,
    progressContext: '',
    verifyCommands: [],
    lastVerify: null,
  });
  assert.ok(executor.includes(qualityClassLine('executor', 'library')));
  const reviewer = buildReviewerTask(prd, {
    round: 1,
    maxRounds: 3,
    reviewerLabel: 'reviewer',
    changedFiles: [],
    verify: [],
    previous: null,
  });
  assert.ok(reviewer.includes(qualityClassLine('reviewer', 'library')));
  assert.ok(reviewer.includes('Quality class: library'));
  const cleaner = buildCleanerTask(['a.ts'], [], 'prototype');
  assert.ok(cleaner.includes(qualityClassLine('cleaner', 'prototype')));
  assert.ok(
    buildCleanerTask(['a.ts'], []).includes(
      qualityClassLine('cleaner', 'production'),
    ),
  );
});

test('draft prompt has the risk-order and class rules', () => {
  const text = buildPrdTask('t', undefined).replace(/\s+/g, ' ');
  assert.match(text, /Order stories by risk, not by quick wins/);
  assert.match(text, /architecture and core abstractions first/);
  assert.match(text, /quick wins last\. Fail fast on risky work/);
  assert.match(text, /`repoQualityClass` \(prototype \| production/);
  assert.match(text, /production when unsure/);
  assert.match(text, /existing callers keep working \(backward compat/);
  assert.match(text, /foundational work first, dependent work later/);
  const withPlan = buildPrdTask('t', { path: 'p.md', content: 'c' });
  assert.match(
    withPlan.replace(/\s+/g, ' '),
    /ordered by the risk classes below; the plan's order breaks ties/,
  );
  assert.match(withPlan, /in the plan's order/);
});
