import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type {
  ParentContext,
  RunAgentOptions,
  RunAgentResult,
} from 'pi-agent-runner';
import {
  delegate,
  type DelegateOptions,
  type DelegationUpdate,
} from '../src/subagents/delegation.ts';

const parent = {
  events: { emit() {}, on: () => () => {} },
  ctx: {},
} as unknown as ParentContext;

const usage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  cost: 0.5,
  turns: 6,
  toolCalls: 7,
  durationMs: 8,
  waitedMs: 9,
};

const options = (extra: Partial<DelegateOptions> = {}): DelegateOptions => ({
  ownerRunId: 'run-1',
  nodeId: 'node-1',
  agent: 'spiral-planner',
  task: 'do it',
  cwd: '/work',
  model: 'x/y',
  thinking: 'high',
  timeoutMs: 1234,
  result: { kind: 'text' },
  permissionAsks: 'forward',
  ...extra,
});

// Records the options the runner received and answers with `outcome`.
const fakeRunner = (outcome: Partial<RunAgentResult> = {}) => {
  const calls: RunAgentOptions[] = [];
  const runAgent = async (call: RunAgentOptions): Promise<RunAgentResult> => {
    calls.push(call);
    return { status: 'completed', value: 'ok', usage, ...outcome };
  };
  return { runAgent, calls };
};

test('unknown agent -> invalid_request without running', async () => {
  const fake = fakeRunner();
  const response = await delegate(parent, options({ agent: 'nope' }), {
    runAgent: fake.runAgent,
  });
  assert.equal(response.status, 'invalid_request');
  assert.equal(response.error, 'unknown agent nope');
  assert.equal(response.ownerRunId, 'run-1');
  assert.equal(response.nodeId, 'node-1');
  assert.equal(fake.calls.length, 0);
});

test('read-only role gets read-only tools and the trimmed prompt', async () => {
  const fake = fakeRunner();
  await delegate(parent, options(), { runAgent: fake.runAgent });
  const [call] = fake.calls;
  assert.deepEqual(call.tools, ['read', 'grep', 'find', 'ls']);
  assert.equal(
    call.systemPrompt,
    readFileSync('agents/planner.md', 'utf8').trim(),
  );
  assert.equal(call.extensions, 'none');
  assert.equal(call.parent, parent);
});

test('writer role keeps the default tools', async () => {
  const fake = fakeRunner();
  await delegate(parent, options({ agent: 'spiral-executor' }), {
    runAgent: fake.runAgent,
  });
  assert.equal(fake.calls[0].tools, undefined);
});

test('options pass through to the runner', async () => {
  const fake = fakeRunner();
  const controller = new AbortController();
  const schema = { type: 'object' };
  await delegate(
    parent,
    options({
      signal: controller.signal,
      permissionAsks: 'deny',
      result: { kind: 'structured', schema },
    }),
    { runAgent: fake.runAgent },
  );
  const [call] = fake.calls;
  assert.equal(call.cwd, '/work');
  assert.equal(call.task, 'do it');
  assert.equal(call.model, 'x/y');
  assert.equal(call.thinking, 'high');
  assert.equal(call.timeoutMs, 1234);
  assert.equal(call.signal, controller.signal);
  assert.equal(call.permissionAsks, 'deny');
  assert.deepEqual(call.result, { kind: 'structured', schema });
});

test('completed text run -> text result, usage, model, thinking', async () => {
  const fake = fakeRunner({ value: 'hello', model: 'x/y' });
  const response = await delegate(parent, options(), {
    runAgent: fake.runAgent,
  });
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.result, { kind: 'text', text: 'hello' });
  assert.deepEqual(response.usage, usage);
  assert.equal(response.model, 'x/y');
  assert.equal(response.thinking, 'high');
  assert.equal(response.error, undefined);
  assert.equal(response.ownerRunId, 'run-1');
  assert.equal(response.nodeId, 'node-1');
  assert.ok(response.requestId);
});

test('completed structured run -> structured result', async () => {
  const value = { verdict: 'APPROVE' };
  const fake = fakeRunner({ value });
  const response = await delegate(
    parent,
    options({ result: { kind: 'structured', schema: {} } }),
    { runAgent: fake.runAgent },
  );
  assert.deepEqual(response.result, { kind: 'structured', value });
});

for (const status of [
  'failed',
  'timed_out',
  'cancelled',
  'structured_output_failed',
] as const) {
  test(`${status} -> status and error, no result`, async () => {
    const fake = fakeRunner({ status, value: 'partial', error: 'boom' });
    const response = await delegate(parent, options(), {
      runAgent: fake.runAgent,
    });
    assert.equal(response.status, status);
    assert.equal(response.error, 'boom');
    assert.equal(response.result, undefined);
    assert.deepEqual(response.usage, usage);
  });
}

test('runner updates are mapped with the request identity', async () => {
  const updates: DelegationUpdate[] = [];
  const runAgent = async (call: RunAgentOptions): Promise<RunAgentResult> => {
    call.onUpdate?.({
      turn: 1,
      tool: 'read',
      toolCalls: 2,
      tokens: 30,
      durationMs: 40,
      recentOutput: 'tail',
    });
    return { status: 'completed', value: '', usage };
  };
  const response = await delegate(
    parent,
    options({ onUpdate: (update) => updates.push(update) }),
    { runAgent },
  );
  assert.deepEqual(updates, [
    {
      requestId: response.requestId,
      ownerRunId: 'run-1',
      nodeId: 'node-1',
      currentTool: 'read',
      recentOutput: 'tail',
      durationMs: 40,
      tokens: 30,
    },
  ]);
});
