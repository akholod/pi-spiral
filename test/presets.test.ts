import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPreset,
  BUILTIN_PRESETS,
  builtinCatalog,
  DEFAULT_CONFIG,
  loadConfig,
  presetNames,
  resolvePreset,
  validateConfig,
} from '../src/config.ts';
import { applyModelOverrides, parseRalplanArgs } from '../src/ralplan/index.ts';
import {
  applyRalphModelOverrides,
  parseRalphArgs,
} from '../src/ralph/index.ts';

// Loads user + project spiral.json given as objects (or raw strings).
const load = (user?: unknown, project?: unknown) => {
  const agentDir = mkdtempSync(join(tmpdir(), 'spiral-preset-agent-'));
  const cwd = mkdtempSync(join(tmpdir(), 'spiral-preset-proj-'));
  const text = (value: unknown) =>
    typeof value === 'string' ? value : JSON.stringify(value);
  if (user !== undefined) {
    writeFileSync(join(agentDir, 'spiral.json'), text(user));
  }
  if (project !== undefined) {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'spiral.json'), text(project));
  }
  return loadConfig(cwd, { agentDir });
};

test('built-in presets are valid on the default config', () => {
  for (const [name, preset] of Object.entries(BUILTIN_PRESETS)) {
    assert.deepEqual(
      validateConfig(applyPreset(DEFAULT_CONFIG, preset)),
      [],
      name,
    );
  }
  const loaded = load();
  assert.equal(loaded.fallback, false);
  assert.deepEqual(presetNames(loaded), ['default', 'deep', 'lite']);
  assert.equal(loaded.presetSources.lite, 'built-in');
});

test('built-ins set thinking and limits, never models', () => {
  const lite = applyPreset(DEFAULT_CONFIG, BUILTIN_PRESETS.lite);
  assert.equal(lite.ralplan.deliberate, 'never');
  assert.equal(lite.ralplan.maxIterations, 3);
  assert.equal(lite.ralplan.roles.critic.thinking, 'medium');
  assert.equal(lite.ralph.maxReviewAttempts, 2);
  assert.equal(lite.ralph.roles.cleaner.thinking, 'low');
  const deep = applyPreset(DEFAULT_CONFIG, BUILTIN_PRESETS.deep);
  assert.equal(deep.ralplan.deliberate, 'always');
  assert.equal(deep.ralplan.roles.critic.thinking, 'xhigh');
  assert.equal(deep.ralph.roles.reviewer.thinking, 'xhigh');
  for (const config of [lite, deep]) {
    assert.equal(config.ralplan.roles.planner.model, 'inherit');
    assert.equal(config.ralph.roles.executor.model, 'inherit');
  }
});

test('a configured preset replaces the built-in of the same name', () => {
  const loaded = load({
    presets: { lite: { ralplan: { maxIterations: 2 } } },
  });
  assert.equal(loaded.fallback, false);
  assert.deepEqual(loaded.presets.lite, { ralplan: { maxIterations: 2 } });
  assert.equal(loaded.presetSources.lite, 'user');
  assert.equal(loaded.presetSources.deep, 'built-in');
  const resolved = resolvePreset(loaded.config, loaded, { requested: 'lite' });
  // replaced entirely: nothing of the built-in lite remains
  assert.equal(resolved.config.ralplan.deliberate, 'auto');
  assert.equal(resolved.config.ralplan.roles.critic.thinking, 'high');
});

test('a project preset replaces the user one entirely', () => {
  const loaded = load(
    {
      presets: {
        fast: { ralplan: { maxIterations: 2 }, ralph: { deslop: false } },
        only: { ralph: { maxIterations: 4 } },
      },
    },
    { presets: { fast: { ralplan: { deliberate: 'never' } } } },
  );
  assert.equal(loaded.fallback, false);
  assert.deepEqual(loaded.presets.fast, {
    ralplan: { deliberate: 'never' },
  });
  assert.equal(loaded.presetSources.fast, 'project');
  assert.equal(loaded.presetSources.only, 'user');
});

test('disallowed or unknown preset keys fail closed', () => {
  for (const key of ['plansDir', 'stateDir', 'verify', 'bogus']) {
    const section = key === 'plansDir' || key === 'bogus' ? 'ralplan' : 'ralph';
    const loaded = load({
      presets: { x: { [section]: { [key]: key === 'verify' ? [] : 'a' } } },
    });
    assert.equal(loaded.fallback, true, key);
    assert.deepEqual(
      loaded.issues.map((i) => `${i.path}: ${i.message}`),
      [`presets.x.${section}.${key}: unknown key`],
    );
  }
  const asks = load({ presets: { x: { permissionAsks: 'deny' } } });
  assert.equal(asks.fallback, true);
  assert.equal(asks.issues[0].path, 'presets.x.permissionAsks');
  assert.equal(asks.config, DEFAULT_CONFIG);
  // built-ins stay listed so /spiral-preset still works
  assert.ok('deep' in asks.presets);
});

test('invalid values in a preset are reported with the preset path', () => {
  const loaded = load({
    presets: {
      bad: { ralplan: { roles: { critic: { thinking: 'ultra' } } } },
    },
  });
  assert.equal(loaded.fallback, true);
  assert.deepEqual(
    loaded.issues.map((i) => i.path),
    ['presets.bad.ralplan.roles.critic.thinking'],
  );
  const range = load({ presets: { bad: { ralplan: { maxIterations: 9 } } } });
  assert.equal(range.issues[0].path, 'presets.bad.ralplan.maxIterations');
  const shape = load({ presets: { bad: 'x' } });
  assert.equal(shape.issues[0].path, 'presets.bad');
});

test('base config issues are not blamed on presets', () => {
  const loaded = load({ ralplan: { maxIterations: 9 } });
  assert.deepEqual(
    loaded.issues.map((i) => i.path),
    ['ralplan.maxIterations'],
  );
});

test('preset names: pattern and reserved default', () => {
  const reserved = load({ presets: { default: {} } });
  assert.equal(reserved.fallback, true);
  assert.match(reserved.issues[0].message, /reserved/);
  const bad = load({ presets: { 'Not Ok': {} } });
  assert.equal(bad.fallback, true);
  assert.equal(bad.issues[0].path, 'presets.Not Ok');
  assert.equal(load({ presets: { 'a-1': {} } }).fallback, false);
});

test('defaultPreset must name a known preset or default', () => {
  assert.equal(load({ defaultPreset: 'nope' }).fallback, true);
  assert.equal(load({ defaultPreset: 'nope' }).issues[0].path, 'defaultPreset');
  assert.equal(load({ defaultPreset: 7 }).fallback, true);
  assert.equal(load({ defaultPreset: 'default' }).fallback, false);
  const builtin = load({ defaultPreset: 'deep' });
  assert.equal(builtin.fallback, false);
  assert.equal(builtin.defaultPreset, 'deep');
  const own = load({ defaultPreset: 'mine', presets: { mine: {} } });
  assert.equal(own.fallback, false);
  // project overrides the user's defaultPreset
  const both = load({ defaultPreset: 'deep' }, { defaultPreset: 'lite' });
  assert.equal(both.defaultPreset, 'lite');
});

test('resolution: requested > session > defaultPreset > none', () => {
  const catalog = { ...builtinCatalog(), defaultPreset: 'deep' };
  const pick = (requested?: string, session?: string) =>
    resolvePreset(DEFAULT_CONFIG, catalog, { requested, session }).preset;
  assert.equal(pick(), 'deep');
  assert.equal(pick(undefined, 'lite'), 'lite');
  assert.equal(pick('deep', 'lite'), 'deep');
  assert.equal(pick('lite', 'deep'), 'lite');
  assert.equal(pick('default', 'lite'), undefined);
  // a stale session choice falls through to defaultPreset
  assert.equal(pick(undefined, 'gone'), 'deep');
  assert.equal(pick(undefined, 'default'), undefined);
  const none = resolvePreset(DEFAULT_CONFIG, builtinCatalog());
  assert.equal(none.preset, undefined);
  assert.equal(none.config, DEFAULT_CONFIG);
});

test('unknown requested preset lists the available ones', () => {
  const result = resolvePreset(DEFAULT_CONFIG, builtinCatalog(), {
    requested: 'nope',
  });
  assert.match(
    result.error ?? '',
    /unknown preset "nope".*default, deep, lite/,
  );
  assert.equal(result.preset, undefined);
  const proto = resolvePreset(DEFAULT_CONFIG, builtinCatalog(), {
    requested: 'constructor',
  });
  assert.ok(proto.error);
});

test('per-role model flags beat the preset, preset beats base', () => {
  const base = {
    ...DEFAULT_CONFIG,
    ralplan: {
      ...DEFAULT_CONFIG.ralplan,
      roles: {
        ...DEFAULT_CONFIG.ralplan.roles,
        critic: { model: 'a/base', thinking: 'high' as const, timeoutMs: 1000 },
      },
    },
  };
  const catalog = builtinCatalog();
  catalog.presets.mine = {
    ralplan: { roles: { critic: { model: 'b/preset' } } },
    ralph: { roles: { reviewer: { model: 'b/preset' } } },
  };
  const { config } = resolvePreset(base, catalog, { requested: 'mine' });
  assert.equal(config.ralplan.roles.critic.model, 'b/preset');
  assert.equal(config.ralplan.roles.critic.timeoutMs, 1000);
  const flagged = applyModelOverrides(config.ralplan, { critic: 'c/flag' });
  assert.equal(flagged.roles.critic.model, 'c/flag');
  assert.equal(flagged.roles.critic.timeoutMs, 1000);
  const ralph = applyRalphModelOverrides(config.ralph, { reviewer: 'c/flag' });
  assert.equal(ralph.roles.reviewer.model, 'c/flag');
  assert.equal(config.ralph.roles.reviewer.model, 'b/preset');
});

test('--preset is parsed by /ralplan and /ralph', () => {
  const plan = parseRalplanArgs('--preset deep --critic a/b build x');
  assert.equal(plan.preset, 'deep');
  assert.equal(plan.models.critic, 'a/b');
  assert.equal(plan.task, 'build x');
  assert.deepEqual(plan.errors, []);
  assert.equal(parseRalplanArgs('task').preset, undefined);
  assert.ok(parseRalplanArgs('--preset --deliberate t').errors.length > 0);
  assert.ok(parseRalplanArgs('t --preset').errors.length > 0);

  const ralph = parseRalphArgs('--preset lite --executor a/b do y');
  assert.equal(ralph.preset, 'lite');
  assert.equal(ralph.models.executor, 'a/b');
  assert.equal(ralph.task, 'do y');
  assert.deepEqual(ralph.errors, []);
  assert.equal(parseRalphArgs('--preset lite --resume').resume, 'latest');
  assert.ok(parseRalphArgs('--preset').errors.length > 0);
});
