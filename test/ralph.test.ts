import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CONFIG, type RalphConfig } from '../src/config.ts';
import { parseRalphArgs, runRalph } from '../src/ralph/index.ts';
import {
  applyRejection,
  normalizeReview,
  type Delegate,
} from '../src/ralph/loop.ts';
import type { Prd } from '../src/ralph/prd.ts';
import type { ExecutorReport, ReviewReport } from '../src/ralph/types.ts';
import type {
  DelegateOptions,
  DelegationResponse,
} from '../src/subagents/delegation.ts';

const pi = {} as ExtensionAPI;

const why = (result: { error?: string; note?: string }): string =>
  `${result.error ?? ''} ${result.note ?? ''}`;

const CRITERIA: Record<string, string[]> = {
  'US-001': ['f() returns 1', 'test/a.test.ts passes'],
  'US-002': ['g() returns 2'],
};

const draft = () => ({
  description: 'two stories',
  verify: [],
  stories: Object.entries(CRITERIA).map(([id, acceptanceCriteria]) => ({
    id,
    title: id,
    description: `implement ${id}`,
    acceptanceCriteria,
  })),
});

const done = (
  story: string,
  criteria: string[],
  extra: Partial<ExecutorReport> = {},
): ExecutorReport => ({
  status: 'done',
  summary: `${story} implemented`,
  filesChanged: [`src/${story}.ts`],
  criteria: criteria.map((criterion) => ({
    criterion,
    met: true,
    evidence: 'ran it',
  })),
  amendments: [],
  learnings: [`learned ${story}`],
  patterns: ['use tabs'],
  blockers: [],
  ...extra,
});

const approve = (
  prd: Prd,
  extra: Partial<ReviewReport> = {},
): ReviewReport => ({
  verdict: 'APPROVE',
  summary: 'all good',
  criteria: prd.userStories.flatMap((s) =>
    s.acceptanceCriteria.map((criterion) => ({
      storyId: s.id,
      criterion,
      status: 'VERIFIED' as const,
      evidence: 'checked',
    })),
  ),
  findings: [],
  optimality: 'fine',
  filesReviewed: [],
  ...extra,
});

// Answers per agent; the executor answer may depend on the story and
// attempt parsed from the node id (`ralph-<i>-executor-<story>`).
interface FakeOptions {
  executor?: (story: string, call: number, task: string) => ExecutorReport;
  reviewer?: (call: number, task: string) => ReviewReport;
  draft?: () => unknown;
  cleaner?: string;
}

const fakeDelegate = (options: FakeOptions = {}) => {
  const calls: DelegateOptions[] = [];
  const counts: Record<string, number> = {};
  const delegateFn: Delegate = async (_pi, request) => {
    calls.push(request);
    const ok = (result: DelegationResponse['result']): DelegationResponse => ({
      requestId: 'r',
      status: 'completed',
      result,
      usage: {
        input: 10,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.001,
        turns: 1,
        toolCalls: 1,
        durationMs: 5,
      },
    });
    const count = (key: string): number =>
      (counts[key] = (counts[key] ?? 0) + 1);
    switch (request.agent) {
      case 'spiral-planner':
        return ok({ kind: 'structured', value: options.draft?.() ?? draft() });
      case 'spiral-executor': {
        const story = request.nodeId.split('-executor-')[1] ?? 'fix';
        const call = count(`exec:${story}`);
        const report =
          options.executor?.(story, call, request.task) ??
          done(story, CRITERIA[story] ?? activeCriteria(request.task));
        return ok({ kind: 'structured', value: report });
      }
      case 'spiral-critic':
      case 'spiral-architect': {
        const call = count('review');
        const value =
          options.reviewer?.(call, request.task) ??
          approve(currentPrd(request.task));
        return ok({ kind: 'structured', value });
      }
      case 'spiral-cleaner':
        return ok({ kind: 'text', text: options.cleaner ?? 'cleaned' });
      default:
        throw new Error(`unexpected agent ${request.agent}`);
    }
  };
  return { delegateFn, calls, counts };
};

// Active criteria of the story in an executor task (review stories are
// created by the loop, so the fake cannot know them up front).
const activeCriteria = (task: string): string[] => {
  const block = task.split('**Acceptance criteria (active):**')[1] ?? '';
  return block
    .split('\n')
    .map((line) => /^\d+\. (.*)$/.exec(line)?.[1])
    .filter((c): c is string => !!c);
};

// The reviewer task embeds the PRD; reconstruct enough of it to approve
// every active criterion (including review stories) from the prompt text.
const currentPrd = (task: string): Prd => {
  const stories: Prd['userStories'] = [];
  const sections = task.split(/^## (?=(?:US|RV)-\d+: )/m).slice(1);
  for (const section of sections) {
    const id = section.slice(0, section.indexOf(':'));
    const block = section.split('**Acceptance criteria:**')[1] ?? '';
    const criteria = block
      .split('\n')
      .map((line) => /^\d+\. (.*)$/.exec(line)?.[1])
      .filter((c): c is string => !!c);
    stories.push({
      id,
      title: id,
      description: '',
      acceptanceCriteria: criteria,
      criterionAmendments: [],
      priority: stories.length + 1,
      passes: true,
      reviewerVerified: false,
      attempts: 1,
      notes: [],
    });
  }
  return {
    project: 'p',
    branchName: 'b',
    description: '',
    verify: [],
    userStories: stories,
  };
};

const config = (extra: Partial<RalphConfig> = {}): RalphConfig => ({
  ...DEFAULT_CONFIG.ralph,
  verify: ['true'],
  ...extra,
});

const run = (
  fake: ReturnType<typeof fakeDelegate>,
  extra: Partial<Parameters<typeof runRalph>[0]> = {},
) =>
  runRalph({
    pi,
    config: config(),
    cwd: mkdtempSync(join(tmpdir(), 'spiral-ralph-')),
    task: 'build the thing',
    delegateFn: fake.delegateFn,
    ...extra,
  });

test('happy path: prd -> stories -> review -> deslop -> completed', async () => {
  const fake = fakeDelegate();
  const result = await run(fake);
  assert.equal(result.outcome, 'completed', why(result));
  assert.deepEqual(
    fake.calls.map((c) => c.agent),
    [
      'spiral-planner',
      'spiral-executor',
      'spiral-executor',
      'spiral-critic',
      'spiral-cleaner',
    ],
  );
  assert.equal(result.deslop, 'done');
  assert.ok(
    result.prd.userStories.every((s) => s.passes && s.reviewerVerified),
  );
  assert.deepEqual(result.changedFiles, ['src/US-001.ts', 'src/US-002.ts']);
  assert.equal(result.usage.runs, 5);
  // state on disk
  assert.ok(existsSync(join(result.runDir, 'prd.json')));
  const progress = readFileSync(join(result.runDir, 'progress.md'), 'utf8');
  assert.match(progress, /use tabs/);
  assert.match(progress, /US-002 attempt 1: passed/);
  // the second executor saw the first story's learnings
  assert.match(fake.calls[2].task, /learned US-001/);
  // cleaner was scoped to the changed files
  assert.match(fake.calls[4].task, /src\/US-001\.ts/);
});

test('--no-deslop skips the cleaner', async () => {
  const fake = fakeDelegate();
  const result = await run(fake, { noDeslop: true });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.deslop, 'skipped');
  assert.ok(!fake.calls.some((c) => c.agent === 'spiral-cleaner'));
});

test('a story with an unmet criterion is retried, then blocked after 3', async () => {
  const fake = fakeDelegate({
    executor: (story) =>
      story === 'US-001'
        ? done(story, ['f() returns 1']) // second criterion never reported
        : done(story, CRITERIA[story]),
  });
  const result = await run(fake);
  assert.equal(result.outcome, 'blocked');
  assert.equal(fake.counts['exec:US-001'], 3);
  assert.match(result.note ?? '', /US-001 failed 3 attempts/);
  const story = result.prd.userStories[0];
  assert.equal(story.passes, false);
  assert.match(story.notes.at(-1) ?? '', /test\/a\.test\.ts passes/);
  // the retry prompt carried the previous attempt's note
  assert.match(fake.calls[2].task, /criteria not met or not reported/);
});

test('executor blocked -> outcome blocked with the blockers', async () => {
  const fake = fakeDelegate({
    executor: (story) =>
      done(story, [], { status: 'blocked', blockers: ['need API key'] }),
  });
  const result = await run(fake);
  assert.equal(result.outcome, 'blocked');
  assert.match(result.note ?? '', /need API key/);
  assert.equal(fake.counts['exec:US-001'], 1);
});

test('regression command failure keeps the story open', async () => {
  const fake = fakeDelegate();
  const result = await run(fake, { config: config({ verify: ['exit 3'] }) });
  assert.equal(result.outcome, 'blocked');
  assert.match(
    result.prd.userStories[0].notes[0],
    /regression commands failed: exit 3/,
  );
  // the retry saw the failing output
  assert.match(fake.calls[2].task, /FAILED exit 3/);
});

test('amendment from the executor is applied through the ledger', async () => {
  const fake = fakeDelegate({
    executor: (story, call) => {
      if (story !== 'US-001') return done(story, CRITERIA[story]);
      if (call === 1) {
        return done(story, ['test/a.test.ts passes'], {
          status: 'incomplete',
          amendments: [
            {
              kind: 'replaced',
              original: 'f() returns 1',
              replacement: 'f() returns 2',
              reason: 'spec was wrong',
              evidence: 'f is documented to return 2 in README:10',
            },
          ],
        });
      }
      return done(story, ['f() returns 2', 'test/a.test.ts passes']);
    },
  });
  const result = await run(fake);
  assert.equal(result.outcome, 'completed', why(result));
  const story = result.prd.userStories[0];
  assert.deepEqual(story.acceptanceCriteria, [
    'f() returns 2',
    'test/a.test.ts passes',
  ]);
  assert.equal(story.criterionAmendments[0].original, 'f() returns 1');
  assert.equal(story.criterionAmendments[0].authority, `ralph:${result.runId}`);
  // the executor's second attempt saw the ledger
  assert.match(fake.calls[2].task, /~~f\(\) returns 1~~/);
});

test('reviewer rejection re-opens the named story, then approves', async () => {
  const fake = fakeDelegate({
    reviewer: (call, task) => {
      const prd = currentPrd(task);
      if (call === 1) {
        return approve(prd, {
          verdict: 'REJECT',
          summary: 'g is wrong',
          findings: [
            {
              severity: 'MAJOR',
              storyId: 'US-002',
              title: 'g returns 3',
              evidence: 'src/US-002.ts:1',
              fix: 'return 2',
            },
          ],
        });
      }
      return approve(prd);
    },
  });
  const result = await run(fake);
  assert.equal(result.outcome, 'completed', why(result));
  assert.equal(fake.counts['exec:US-002'], 2);
  assert.equal(fake.counts.review, 2);
  assert.match(
    result.prd.userStories[1].notes[1],
    /reviewer round 1 \[MAJOR\] g returns 3: return 2/,
  );
  assert.equal(result.reviews.length, 2);
});

test('orphan blocking findings become a review story', () => {
  const prd = currentPrd('## US-001: x\n**Acceptance criteria:**\n1. a\n');
  const review = approve(prd, {
    verdict: 'REJECT',
    findings: [
      {
        severity: 'CRITICAL',
        storyId: '',
        title: 'leak',
        evidence: 'e',
        fix: 'close the handle',
      },
    ],
  });
  const reopened = applyRejection(prd, review, 1);
  assert.deepEqual(reopened, ['RV-001']);
  assert.deepEqual(prd.userStories[1].acceptanceCriteria, [
    'leak: close the handle',
  ]);
});

test('APPROVE with uncovered or unverified criteria is downgraded', () => {
  const prd = currentPrd(
    '## US-001: x\n**Acceptance criteria:**\n1. a\n2. b\n',
  );
  const partial = approve(prd);
  partial.criteria[1].status = 'PARTIAL';
  assert.equal(normalizeReview(prd, partial).verdict, 'REJECT');
  const uncovered = approve(prd, { criteria: [] });
  assert.match(
    normalizeReview(prd, uncovered).summary,
    /2 criteria not covered/,
  );
  assert.equal(normalizeReview(prd, approve(prd)).verdict, 'APPROVE');
});

test('review budget exhausted -> exhausted, stories still pass', async () => {
  const fake = fakeDelegate({
    reviewer: (_call, task) =>
      approve(currentPrd(task), { verdict: 'REJECT', summary: 'never' }),
  });
  const result = await run(fake, { config: config({ maxReviewAttempts: 2 }) });
  assert.equal(result.outcome, 'exhausted', why(result));
  assert.equal(fake.counts.review, 2);
  assert.match(result.note ?? '', /did not approve after 2/);
  // each rejection without findings became a review story the executor closed
  assert.deepEqual(
    result.prd.userStories.map((s) => s.id),
    ['US-001', 'US-002', 'RV-001', 'RV-002'],
  );
  assert.ok(result.prd.userStories.every((s) => s.passes));
});

test('post-deslop regression: fix attempts, then failed', async () => {
  let cleaned = false;
  const fake = fakeDelegate({
    executor: (story) => {
      if (story.startsWith('US')) return done(story, CRITERIA[story]);
      return done('fix', [], { status: 'incomplete', summary: 'could not' });
    },
  });
  // verify passes until the cleaner ran, then fails
  const cwd = mkdtempSync(join(tmpdir(), 'spiral-ralph-'));
  const marker = join(cwd, 'broken');
  const wrapped: Delegate = async (p, req) => {
    const response = await fake.delegateFn(p, req);
    if (req.agent === 'spiral-cleaner') {
      cleaned = true;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(marker, '');
    }
    return response;
  };
  const result = await runRalph({
    pi,
    config: config({ verify: [`test ! -e ${marker}`] }),
    cwd,
    task: 't',
    delegateFn: wrapped,
  });
  assert.ok(cleaned);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.deslop, 'failed');
  assert.equal(fake.counts['exec:fix'], 2);
  assert.equal(
    fake.calls.filter((c) => c.nodeId.includes('regression-fix')).length,
    2,
  );
});

test('generic PRD draft is sent back once, then fails', async () => {
  const fake = fakeDelegate({
    draft: () => ({
      description: 'd',
      verify: [],
      stories: [
        {
          id: 'US-001',
          title: 't',
          description: 'd',
          acceptanceCriteria: ['Implementation is complete'],
        },
      ],
    }),
  });
  const result = await run(fake);
  assert.equal(result.outcome, 'failed');
  assert.match(result.error ?? '', /generic criterion/);
  assert.equal(
    fake.calls.filter((c) => c.agent === 'spiral-planner').length,
    2,
  );
  assert.match(fake.calls[1].task, /previous draft was rejected/);
});

test('plan artifact content reaches the PRD planner', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'spiral-ralph-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(cwd, 'plan.md'), '# The plan\n\nDo X then Y.');
  const fake = fakeDelegate();
  const result = await run(fake, { cwd, plan: 'plan.md' });
  assert.equal(result.outcome, 'completed', why(result));
  assert.match(fake.calls[0].task, /Do X then Y/);
  assert.equal(result.prd.planArtifact, join(cwd, 'plan.md'));
});

test('resume continues from disk without re-drafting', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'spiral-ralph-'));
  const first = fakeDelegate({
    executor: (story) =>
      story === 'US-002'
        ? done(story, [], { status: 'blocked', blockers: ['ask user'] })
        : done(story, CRITERIA[story]),
  });
  const stopped = await run(first, { cwd });
  assert.equal(stopped.outcome, 'blocked');
  const second = fakeDelegate();
  const resumed = await run(second, { cwd, task: '', resume: 'latest' });
  assert.equal(resumed.outcome, 'completed', why(resumed));
  assert.equal(resumed.runId, stopped.runId);
  assert.ok(!second.calls.some((c) => c.agent === 'spiral-planner'));
  // US-001 already passed: only US-002 is re-attempted
  assert.deepEqual(
    second.calls.map((c) => c.agent),
    ['spiral-executor', 'spiral-critic', 'spiral-cleaner'],
  );
  assert.ok(second.calls[0].nodeId.endsWith('US-002'));
});

test('cancelled executor -> aborted', async () => {
  const fake = fakeDelegate();
  const cancelling: Delegate = async (p, req) =>
    req.agent === 'spiral-executor'
      ? { requestId: 'r', status: 'cancelled' }
      : fake.delegateFn(p, req);
  const result = await run(fake, { delegateFn: cancelling });
  assert.equal(result.outcome, 'aborted');
});

test('parseRalphArgs', () => {
  const parsed = parseRalphArgs(
    '--no-deslop --reviewer-agent architect --plan .spiral/plans/x.md --executor a/b build it now',
  );
  assert.equal(parsed.task, 'build it now');
  assert.equal(parsed.noDeslop, true);
  assert.equal(parsed.reviewerAgent, 'architect');
  assert.equal(parsed.plan, '.spiral/plans/x.md');
  assert.deepEqual(parsed.models, { executor: 'a/b' });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parseRalphArgs('--resume').resume, 'latest');
  assert.equal(parseRalphArgs('--resume abc').resume, 'abc');
  assert.deepEqual(parseRalphArgs('--resume').errors, []);
  assert.ok(parseRalphArgs('').errors.length > 0);
  assert.ok(parseRalphArgs('--reviewer-agent bogus x').errors.length > 0);
  assert.ok(parseRalphArgs('--plan').errors.length > 0);
});
