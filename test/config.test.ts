import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  deepMerge,
  loadConfig,
  parseJsonc,
  validateConfig,
} from '../src/config.ts';
import { detectPlanMode } from '../src/ralplan/prompts.ts';
import { parseRalplanArgs } from '../src/ralplan/index.ts';

test('defaults are valid', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test('jsonc: comments, trailing commas, slashes inside strings', () => {
  const parsed = parseJsonc(`{
    // comment
    "a": 1, /* block */
    "url": "http://x/y", // keep the url
    "s": "foo // bar",
    "t": "a /* b */ c",
    "e": "q\\"//x",
    "arr": [1, 2,],
  }`);
  assert.deepEqual(parsed, {
    a: 1,
    url: 'http://x/y',
    s: 'foo // bar',
    t: 'a /* b */ c',
    e: 'q"//x',
    arr: [1, 2],
  });
});

test('project overrides a single role field without dropping others', () => {
  const merged = deepMerge(DEFAULT_CONFIG, {
    ralplan: { roles: { critic: { model: 'foo/bar' } } },
  });
  assert.equal(merged.ralplan.roles.critic.model, 'foo/bar');
  assert.equal(merged.ralplan.roles.critic.thinking, 'high');
  assert.equal(
    merged.ralplan.roles.planner.model,
    DEFAULT_CONFIG.ralplan.roles.planner.model,
  );
});

test('null or scalar in place of an object does not break the shape', () => {
  const merged = deepMerge(DEFAULT_CONFIG, { ralplan: null, ralph: 'x' });
  assert.deepEqual(merged, DEFAULT_CONFIG);
  assert.deepEqual(validateConfig(merged), []);
});

test('validation: thinking, maxIterations cap, plansDir, timeout cap', () => {
  const merged = deepMerge(DEFAULT_CONFIG, {
    ralplan: {
      maxIterations: 6,
      plansDir: '../outside',
      roles: {
        planner: { thinking: 'ultra', timeoutMs: 3_000_000_000 },
      },
    },
  });
  const paths = validateConfig(merged)
    .map((issue) => issue.path)
    .sort();
  assert.deepEqual(paths, [
    'ralplan.maxIterations',
    'ralplan.plansDir',
    'ralplan.roles.planner.thinking',
    'ralplan.roles.planner.timeoutMs',
  ]);
});

const tempProject = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'spiral-'));
  mkdirSync(join(cwd, '.pi'));
  return cwd;
};

// empty home so the developer's real ~/.pi/agent/spiral.json is not read
const home = mkdtempSync(join(tmpdir(), 'spiral-home-'));
const load = (cwd: string, extra: { projectTrusted?: boolean } = {}) =>
  loadConfig(cwd, { homeDir: home, ...extra });

test('ralph.stateDir must be outside the project', () => {
  const bad = deepMerge(DEFAULT_CONFIG, {
    ralph: { stateDir: '.spiral/ralph' },
  });
  assert.deepEqual(
    validateConfig(bad).map((issue) => issue.path),
    ['ralph.stateDir'],
  );
  const dots = deepMerge(DEFAULT_CONFIG, { ralph: { stateDir: '~/../x' } });
  assert.equal(validateConfig(dots).length, 1);
  const ok = deepMerge(DEFAULT_CONFIG, { ralph: { stateDir: '/tmp/ralph' } });
  assert.deepEqual(validateConfig(ok), []);
});

test('loadConfig falls back to defaults on invalid project config', () => {
  const cwd = tempProject();
  writeFileSync(join(cwd, '.pi', 'spiral.json'), '{"ralplan": null}');
  const loaded = load(cwd);
  assert.equal(loaded.fallback, true);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.ok(loaded.issues.some((issue) => issue.path === 'ralplan'));
});

test('loadConfig reports unknown keys and parse errors', () => {
  const cwd = tempProject();
  writeFileSync(join(cwd, '.pi', 'spiral.json'), '{"ralplam": {}}');
  assert.ok(load(cwd).issues.some((issue) => issue.message === 'unknown key'));
  writeFileSync(join(cwd, '.pi', 'spiral.json'), '{"ralplan": ');
  assert.ok(
    load(cwd).issues.some((issue) => issue.message.startsWith('cannot parse')),
  );
});

test('loadConfig ignores project config when the project is untrusted', () => {
  const cwd = tempProject();
  writeFileSync(
    join(cwd, '.pi', 'spiral.json'),
    '{"ralplan": {"maxIterations": 2}}',
  );
  const trusted = load(cwd, { projectTrusted: true });
  const untrusted = load(cwd, { projectTrusted: false });
  assert.equal(trusted.config.ralplan.maxIterations, 2);
  assert.equal(untrusted.config.ralplan.maxIterations, 5);
  assert.deepEqual(untrusted.sources, []);
});

test('deliberate mode auto-detects risk signals', () => {
  assert.equal(detectPlanMode('add oauth login', 'auto'), 'deliberate');
  assert.equal(detectPlanMode('security hardening pass', 'auto'), 'deliberate');
  assert.equal(
    detectPlanMode('breaking change in public api', 'auto'),
    'deliberate',
  );
  assert.equal(detectPlanMode('fix XSS in comments', 'auto'), 'deliberate');
  assert.equal(detectPlanMode('add authentication', 'auto'), 'deliberate');
  assert.equal(detectPlanMode('rename a variable', 'auto'), 'short');
  assert.equal(detectPlanMode('rename a variable', 'always'), 'deliberate');
  assert.equal(detectPlanMode('drop the users table', 'never'), 'short');
});

test('ralplan args parsing', () => {
  const parsed = parseRalplanArgs(
    '--deliberate --critic openai-codex/gpt-5.6-luna add   caching layer',
  );
  assert.deepEqual(parsed, {
    task: 'add caching layer',
    deliberate: true,
    interactive: false,
    models: { critic: 'openai-codex/gpt-5.6-luna' },
    errors: [],
  });
  const bad = parseRalplanArgs('--architect --interactive task');
  assert.deepEqual(bad.errors, ['--architect requires a provider/model id']);
  assert.equal(bad.interactive, true);
});
