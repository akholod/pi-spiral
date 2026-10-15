import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderArtifact,
  reviewsDirOf,
  writeArtifact,
  writeArtifacts,
} from '../src/ralplan/artifact.ts';
import { emptyUsage } from '../src/subagents/responses.ts';
import type { RalplanRequest, RalplanResult } from '../src/ralplan/types.ts';
import { planBody } from '../src/ralph/plan-body.ts';

const request: RalplanRequest = {
  runId: 'run-1',
  task: 'do it',
  cwd: '/x',
  mode: 'short',
  interactive: false,
};

const result = (outcome: RalplanResult['outcome']): RalplanResult => ({
  outcome,
  finalPlan: 'FINAL PLAN',
  usage: emptyUsage(),
  iterations: [
    {
      iteration: 1,
      plan: 'plan one',
      architectReview: 'arch one',
      criticReview: {
        verdict: 'ITERATE',
        mode: 'THOROUGH',
        summary: 's',
        preCommitment: 'p',
        findings: [],
        gaps: [],
        ambiguities: [],
        perspectives: { executor: 'x', stakeholder: 's', skeptic: 'k' },
        gates: {
          principleOptionConsistency: { pass: true, reason: 'r' },
          alternativesDepth: { pass: true, reason: 'r' },
          riskVerificationRigor: { pass: true, reason: 'r' },
          deliberateAdditions: { pass: true, reason: 'r' },
        },
        justification: 'j',
        openQuestions: [],
      },
    },
  ],
});

test('non-approved artifact states the outcome and links the reviews', () => {
  const text = renderArtifact(request, result('exhausted'), 'p-reviews');
  assert.match(text, /^reviews: "p-reviews"$/m);
  assert.match(text, /^usage: ".*child run/m);
  assert.match(text, /Not approved: critic did not approve after 1/);
  assert.match(text, /reviews in p-reviews\/\./);
  assert.ok(!text.includes('arch one'));
});

test('reviews write failure keeps the plan and returns a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spiral-art-'));
  const path = join(dir, 'p.md');
  writeFileSync(reviewsDirOf(path), 'a file in the way');
  const { warning } = writeArtifacts(path, request, result('approved'));
  assert.match(warning ?? '', /reviews folder not fully written/);
  assert.match(readFileSync(path, 'utf8'), /FINAL PLAN/);
});

test('writeArtifacts never overwrites the plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spiral-art-'));
  const path = join(dir, 'p.md');
  writeArtifacts(path, request, result('approved'));
  assert.ok(existsSync(join(reviewsDirOf(path), 'critic-v1.md')));
  assert.throws(
    () => writeArtifacts(path, request, result('approved')),
    /EEXIST/,
  );
  assert.throws(() => writeArtifact(path, 'x'), /EEXIST/);
});

test('planBody strips frontmatter and old review history', () => {
  const old = [
    '---',
    'status: pending-approval',
    '---',
    '',
    '# Plan: t',
    '',
    'THE PLAN',
    '',
    '---',
    '',
    '## Review history',
    '',
    '### Iteration 1',
    'secret review',
    '## Usage',
    '1 run',
  ].join('\n');
  assert.equal(planBody(old), '# Plan: t\n\nTHE PLAN');
  const fresh = renderArtifact(request, result('approved'), 'p-reviews');
  assert.equal(
    planBody(fresh),
    '# Plan: do it\n\nConsensus: critic APPROVE after 1 iteration(s); ' +
      'architect and critic reviews in p-reviews/.\n\nFINAL PLAN',
  );
  assert.equal(
    planBody('no frontmatter\n---\nkept'),
    'no frontmatter\n---\nkept',
  );
});

test("the planner's own H1 becomes the title, not a second heading", () => {
  const titled = {
    ...result('approved'),
    finalPlan: '# Plan: add mul\n\n## Steps\n1. do it',
  };
  const text = renderArtifact(request, titled, 'p-reviews');
  const body = text.split('---\n').at(-1) ?? '';
  assert.equal(body.match(/^# /gm)?.length, 1);
  assert.match(body, /^\n# Plan: add mul\n\nConsensus: [^\n]+\n\n## Steps/);
});
