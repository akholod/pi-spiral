import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { applyModelOverrides, runRalplan } from '../src/ralplan/index.ts';
import { normalizeReview, type Delegate } from '../src/ralplan/loop.ts';
import type {
  CriticReview,
  CheckpointDecision,
  GateResult,
} from '../src/ralplan/types.ts';
import type {
  DelegateOptions,
  DelegationResponse,
} from '../src/subagents/delegation.ts';

const pi = {} as ExtensionAPI;

const gate = (pass = true): GateResult => ({ pass, reason: 'r' });

const review = (
  verdict: CriticReview['verdict'],
  severities: CriticReview['findings'][number]['severity'][] = [],
  failedGate?: keyof CriticReview['gates'],
): CriticReview => ({
  verdict,
  mode: 'THOROUGH',
  summary: `${verdict} summary`,
  preCommitment: 'p',
  findings: severities.map((severity) => ({
    severity,
    title: 't',
    evidence: 'e',
    why: 'w',
    fix: 'f',
    confidence: 'HIGH',
  })),
  gaps: [],
  ambiguities: [],
  perspectives: { executor: 'x', stakeholder: 's', skeptic: 'k' },
  gates: {
    principleOptionConsistency: gate(
      failedGate !== 'principleOptionConsistency',
    ),
    alternativesDepth: gate(failedGate !== 'alternativesDepth'),
    riskVerificationRigor: gate(failedGate !== 'riskVerificationRigor'),
    deliberateAdditions: gate(failedGate !== 'deliberateAdditions'),
  },
  justification: 'j',
  openQuestions: [],
});

interface FakeOptions {
  verdicts: CriticReview[];
  plannerText?: (call: number, task: string) => string;
}

// Records every delegation and answers by role.
const fakeDelegate = (options: FakeOptions) => {
  const calls: DelegateOptions[] = [];
  let planner = 0;
  let critic = 0;
  const delegateFn: Delegate = async (_pi, request) => {
    calls.push(request);
    const done = (
      result: DelegationResponse['result'],
    ): DelegationResponse => ({
      requestId: 'r',
      status: 'completed',
      result,
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        turns: 1,
        toolCalls: 2,
        durationMs: 1000,
      },
    });
    if (request.agent === 'spiral-planner') {
      planner++;
      const text =
        options.plannerText?.(planner, request.task) ?? `plan v${planner}`;
      return done({ kind: 'text', text });
    }
    if (request.agent === 'spiral-architect') {
      return done({ kind: 'text', text: `ARCHITECT-SECRET-${planner}` });
    }
    const value = options.verdicts[critic++] ?? review('APPROVE');
    return done({ kind: 'structured', value });
  };
  return { delegateFn, calls };
};

const run = (
  fake: ReturnType<typeof fakeDelegate>,
  extra: Partial<Parameters<typeof runRalplan>[0]> = {},
) =>
  runRalplan({
    pi,
    config: DEFAULT_CONFIG.ralplan,
    cwd: mkdtempSync(join(tmpdir(), 'spiral-loop-')),
    task: 'do the thing',
    delegateFn: fake.delegateFn,
    ...extra,
  });

test('roles run in order, critic never sees the architect review', async () => {
  const fake = fakeDelegate({
    verdicts: [review('ITERATE'), review('APPROVE')],
  });
  const result = await run(fake);
  assert.equal(result.outcome, 'approved');
  assert.equal(result.iterations.length, 2);
  assert.deepEqual(
    fake.calls.map((call) => call.agent),
    [
      'spiral-planner',
      'spiral-architect',
      'spiral-critic',
      'spiral-planner',
      'spiral-architect',
      'spiral-critic',
    ],
  );
  const critics = fake.calls.filter((call) => call.agent === 'spiral-critic');
  for (const call of critics)
    assert.ok(!call.task.includes('ARCHITECT-SECRET'));
  // Architect and critic get the identical snapshot.
  assert.ok(fake.calls[1].task.includes('plan v1'));
  assert.ok(fake.calls[2].task.includes('plan v1'));
  // The planner revision gets both reviews.
  assert.ok(fake.calls[3].task.includes('ARCHITECT-SECRET-1'));
  assert.ok(fake.calls[3].task.includes('ITERATE summary'));
  // Identity is a per-run UUID plus unique node ids.
  const owners = new Set(fake.calls.map((call) => call.ownerRunId));
  assert.equal(owners.size, 1);
  assert.match([...owners][0], /^[0-9a-f-]{36}$/);
  assert.equal(new Set(fake.calls.map((call) => call.nodeId)).size, 6);
  assert.ok(result.artifactPath && existsSync(result.artifactPath));
  const artifact = readFileSync(result.artifactPath, 'utf8');
  assert.ok(artifact.startsWith('---\nstatus: pending-approval\n'));
  assert.ok(artifact.includes('### Ralplan gates'));
  // Usage aggregated over all 6 child runs.
  assert.equal(result.usage.runs, 6);
  assert.equal(result.usage.input, 600);
  assert.ok(Math.abs(result.usage.cost - 0.06) < 1e-9);
  assert.match(artifact, /cost_usd: 0\.0600/);
});

test('APPROVE with a failed gate is downgraded to ITERATE', () => {
  const normalized = normalizeReview(
    review('APPROVE', [], 'alternativesDepth'),
  );
  assert.equal(normalized.verdict, 'ITERATE');
  assert.match(normalized.summary, /failed gates: alternativesDepth/);
});

test('per-run model overrides reach the delegation request', async () => {
  const overridden = applyModelOverrides(DEFAULT_CONFIG.ralplan, {
    critic: 'x/y',
  });
  assert.equal(overridden.roles.critic.model, 'x/y');
  assert.equal(
    overridden.roles.planner.model,
    DEFAULT_CONFIG.ralplan.roles.planner.model,
  );
  const fake = fakeDelegate({ verdicts: [review('APPROVE')] });
  await run(fake, { models: { critic: 'x/y', planner: 'p/q' } });
  assert.equal(fake.calls[0].model, 'p/q');
  assert.equal(
    fake.calls[1].model,
    DEFAULT_CONFIG.ralplan.roles.architect.model,
  );
  assert.equal(fake.calls[2].model, 'x/y');
});

test('APPROVE with a MAJOR finding is downgraded to ITERATE', async () => {
  assert.equal(
    normalizeReview(review('APPROVE', ['MAJOR'])).verdict,
    'ITERATE',
  );
  assert.equal(
    normalizeReview(review('APPROVE', ['MINOR'])).verdict,
    'APPROVE',
  );
  const fake = fakeDelegate({
    verdicts: [review('APPROVE', ['CRITICAL']), review('APPROVE')],
  });
  const result = await run(fake);
  assert.equal(result.outcome, 'approved');
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].criticReview.verdict, 'ITERATE');
});

test('maxIterations is respected and yields exhausted', async () => {
  const fake = fakeDelegate({ verdicts: Array(5).fill(review('ITERATE')) });
  const result = await run(fake);
  assert.equal(result.outcome, 'exhausted');
  assert.equal(result.iterations.length, 5);
  assert.ok(result.artifactPath);
  assert.match(
    readFileSync(result.artifactPath, 'utf8'),
    /^---\nstatus: pending-approval-unreviewed/,
  );
});

test('empty planner output is a failure and writes no artifact', async () => {
  const fake = fakeDelegate({ verdicts: [], plannerText: () => '   ' });
  const result = await run(fake);
  assert.equal(result.outcome, 'failed');
  assert.match(result.error ?? '', /planner returned an empty response/);
  assert.equal(result.artifactPath, undefined);
});

test('interactive: draft feedback, then final approval', async () => {
  const fake = fakeDelegate({ verdicts: [review('APPROVE')] });
  const seen: string[] = [];
  let asked = 0;
  const result = await run(fake, {
    interactive: true,
    onCheckpoint: async (checkpoint): Promise<CheckpointDecision> => {
      seen.push(checkpoint);
      asked++;
      if (asked === 1) return { action: 'changes', feedback: 'add tests' };
      return { action: 'proceed' };
    },
  });
  assert.equal(result.outcome, 'approved');
  assert.deepEqual(seen, ['draft', 'draft', 'final']);
  assert.ok(fake.calls[1].agent === 'spiral-planner');
  assert.ok(fake.calls[1].task.includes('add tests'));
  assert.ok(fake.calls[2].task.includes('plan v2'));
});

test('interactive: reject at final writes nothing', async () => {
  const fake = fakeDelegate({ verdicts: [review('APPROVE')] });
  const result = await run(fake, {
    interactive: true,
    onCheckpoint: async (checkpoint): Promise<CheckpointDecision> =>
      checkpoint === 'final' ? { action: 'reject' } : { action: 'proceed' },
  });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.artifactPath, undefined);
});

test('interactive flag without a handler is ignored', async () => {
  const fake = fakeDelegate({ verdicts: [review('APPROVE')] });
  const result = await run(fake, { interactive: true });
  assert.equal(result.outcome, 'approved');
  assert.equal(fake.calls.length, 3);
});
