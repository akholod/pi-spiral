import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, parseModelId, validateConfig } from '../src/config.ts';
import { applyModelOverrides } from '../src/ralplan/index.ts';
import { preflightModels, type ModelLookup } from '../src/ralplan/preflight.ts';

const registry = (known: string[], authed: string[] = known): ModelLookup => ({
  find: (provider, modelId) =>
    known.includes(`${provider}/${modelId}`)
      ? { id: `${provider}/${modelId}` }
      : undefined,
  hasConfiguredAuth: (model) =>
    authed.includes((model as unknown as { id: string }).id),
});

test('defaults inherit the session model for every role', () => {
  for (const role of Object.values(DEFAULT_CONFIG.ralplan.roles)) {
    assert.equal(role.model, 'inherit');
  }
});

test('parseModelId', () => {
  assert.deepEqual(parseModelId('a/b'), { provider: 'a', modelId: 'b' });
  assert.deepEqual(parseModelId('a/b/c'), { provider: 'a', modelId: 'b/c' });
  assert.equal(parseModelId('inherit'), undefined);
  assert.equal(parseModelId('nope'), undefined);
  assert.equal(parseModelId('a/'), undefined);
});

test('malformed model ids are config issues', () => {
  const config = applyModelOverrides(DEFAULT_CONFIG.ralplan, {
    critic: 'just-a-name',
  });
  const issues = validateConfig({ ...DEFAULT_CONFIG, ralplan: config });
  assert.deepEqual(
    issues.map((issue) => issue.path),
    ['ralplan.roles.critic.model'],
  );
});

test('preflight: all inherit -> no errors, one warning about the critic', () => {
  const result = preflightModels(DEFAULT_CONFIG.ralplan, registry([]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /critic runs on the same model/);
});

test('preflight: unknown model and missing auth are errors', () => {
  const config = applyModelOverrides(DEFAULT_CONFIG.ralplan, {
    planner: 'x/known',
    architect: 'x/noauth',
    critic: 'x/missing',
  });
  const result = preflightModels(
    config,
    registry(['x/known', 'x/noauth'], ['x/known']),
  );
  assert.deepEqual(result.errors, [
    'architect: no credentials configured for "x/noauth"',
    'critic: model "x/missing" is not known to pi',
  ]);
  assert.deepEqual(result.warnings, []);
});

test('preflight: distinct critic model gives no warning', () => {
  const config = applyModelOverrides(DEFAULT_CONFIG.ralplan, { critic: 'x/c' });
  const result = preflightModels(config, registry(['x/c']));
  assert.deepEqual(result, { errors: [], warnings: [] });
});
