import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ThinkingLevel =
  'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RoleConfig {
  model: string;
  thinking: ThinkingLevel;
  timeoutMs: number;
}

export type DeliberateMode = 'auto' | 'always' | 'never';

export interface RalplanConfig {
  maxIterations: number;
  plansDir: string;
  deliberate: DeliberateMode;
  roles: {
    planner: RoleConfig;
    architect: RoleConfig;
    critic: RoleConfig;
  };
}

// Which registered agent verifies the finished PRD (OMC `--critic=`).
export type ReviewerAgent = 'critic' | 'architect';

export interface RalphConfig {
  // story attempts (review rounds have their own budget)
  maxIterations: number;
  // run state root, outside the working tree: `~/...` or absolute;
  // unset = `<pi agent dir>/spiral/ralph`
  stateDir?: string;
  // post-approval ai-slop-cleaner pass on changed files (OMC step 7.5)
  deslop: boolean;
  reviewerAgent: ReviewerAgent;
  // reviewer rounds before giving up (OMC max_verification_attempts)
  maxReviewAttempts: number;
  // regression commands the loop runs itself; empty = use the PRD's list
  verify: string[];
  verifyTimeoutMs: number;
  // opt-in token budget for one run (input + output of all children,
  // across resumes); 0 = off
  budgetTokens: number;
  roles: {
    // drafts prd.json (planner agent, read-only)
    prd: RoleConfig;
    executor: RoleConfig;
    reviewer: RoleConfig;
    cleaner: RoleConfig;
  };
}

// What a permission `ask` means inside child agents; see
// spiral.config.example.jsonc.
export type PermissionAsks = 'forward' | 'deny';

export interface SpiralConfig {
  permissionAsks: PermissionAsks;
  ralplan: RalplanConfig;
  ralph: RalphConfig;
}

type PartialRole = Partial<RoleConfig>;

// A preset is a partial overlay on the base config: only the knobs that
// make sense per run (effort, models, iteration limits). Paths, state dirs,
// verify commands and permissions stay in the base config.
export interface Preset {
  ralplan?: {
    maxIterations?: number;
    deliberate?: DeliberateMode;
    roles?: Partial<Record<keyof RalplanConfig['roles'], PartialRole>>;
  };
  ralph?: {
    maxIterations?: number;
    deslop?: boolean;
    reviewerAgent?: ReviewerAgent;
    maxReviewAttempts?: number;
    budgetTokens?: number;
    roles?: Partial<Record<keyof RalphConfig['roles'], PartialRole>>;
  };
}

export type PresetSource = 'built-in' | 'user' | 'project';

// `inherit` = the model of the pi session that runs the command. Built-in
// defaults never name a provider so the package works on any install; the
// recommended Opus/GPT profile lives in spiral.config.example.jsonc.
export const INHERIT = 'inherit';

// Hard limits. RALPLAN_MAX_ITERATIONS mirrors the OMC reference (5 rounds).
// MAX_TIMEOUT_MS is setTimeout's maximum delay.
export const RALPLAN_MAX_ITERATIONS = 5;
export const RALPH_MAX_ITERATIONS = 100;
export const RALPH_MAX_REVIEW_ATTEMPTS = 10;
export const MAX_TIMEOUT_MS = 2_147_483_647;

export const DEFAULT_CONFIG: SpiralConfig = {
  permissionAsks: 'forward',
  ralplan: {
    maxIterations: RALPLAN_MAX_ITERATIONS,
    plansDir: '.spiral/plans',
    deliberate: 'auto',
    roles: {
      planner: { model: INHERIT, thinking: 'high', timeoutMs: 900_000 },
      architect: { model: INHERIT, thinking: 'high', timeoutMs: 600_000 },
      critic: { model: INHERIT, thinking: 'high', timeoutMs: 600_000 },
    },
  },
  ralph: {
    maxIterations: 20,
    stateDir: undefined,
    deslop: true,
    reviewerAgent: 'critic',
    maxReviewAttempts: 3,
    verify: [],
    verifyTimeoutMs: 600_000,
    budgetTokens: 0,
    roles: {
      prd: { model: INHERIT, thinking: 'high', timeoutMs: 900_000 },
      executor: { model: INHERIT, thinking: 'medium', timeoutMs: 1_800_000 },
      reviewer: { model: INHERIT, thinking: 'high', timeoutMs: 900_000 },
      cleaner: { model: INHERIT, thinking: 'medium', timeoutMs: 1_200_000 },
    },
  },
};

// Reserved name: no preset, the merged base config as is.
export const DEFAULT_PRESET = 'default';

// No provider names: models stay whatever the base config says.
export const BUILTIN_PRESETS: Record<string, Preset> = {
  lite: {
    ralplan: {
      maxIterations: 3,
      deliberate: 'never',
      roles: {
        planner: { thinking: 'low' },
        architect: { thinking: 'low' },
        critic: { thinking: 'medium' },
      },
    },
    ralph: {
      maxReviewAttempts: 2,
      roles: {
        prd: { thinking: 'medium' },
        executor: { thinking: 'medium' },
        reviewer: { thinking: 'medium' },
        cleaner: { thinking: 'low' },
      },
    },
  },
  deep: {
    ralplan: {
      deliberate: 'always',
      roles: {
        planner: { thinking: 'high' },
        architect: { thinking: 'high' },
        critic: { thinking: 'xhigh' },
      },
    },
    ralph: {
      roles: {
        prd: { thinking: 'high' },
        executor: { thinking: 'high' },
        reviewer: { thinking: 'xhigh' },
        cleaner: { thinking: 'medium' },
      },
    },
  },
};

export const CONFIG_FILE_NAME = 'spiral.json';

// pi's default agent dir; the extension passes pi's own getAgentDir()
// (which honors PI_CODING_AGENT_DIR) instead.
export const defaultAgentDir = (
  configDirName: string,
  homeDir = homedir(),
): string => join(homeDir, configDirName, 'agent');

export const getUserConfigPath = (agentDir: string): string =>
  join(agentDir, CONFIG_FILE_NAME);

export const getProjectConfigPath = (
  cwd: string,
  configDirName: string,
): string => join(cwd, configDirName, CONFIG_FILE_NAME);

// Character-level JSONC stripper: comments are removed only outside string
// literals, trailing commas before `}` / `]` are dropped.
export const stripJsonc = (text: string): string => {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
      } else {
        out += ch;
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
};

export const parseJsonc = (text: string): unknown =>
  JSON.parse(stripJsonc(text));

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Merges `override` into `base`. Where base holds an object and override
// holds a non-object, the override is ignored (the shape is preserved); the
// validator reports it separately via checkShape.
export const deepMerge = <T extends object>(base: T, override: unknown): T => {
  if (!isPlainObject(override)) return base;
  const result: PlainObject = { ...(base as PlainObject) };
  for (const key of Object.keys(override)) {
    const baseValue = result[key];
    const overrideValue = override[key];
    if (isPlainObject(baseValue)) {
      if (isPlainObject(overrideValue)) {
        result[key] = deepMerge(baseValue, overrideValue);
      }
    } else if (overrideValue !== undefined) {
      result[key] = overrideValue;
    }
  }
  return result as T;
};

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface ConfigIssue {
  path: string;
  message: string;
}

// Structural check of a raw override against the default shape: every key
// that is an object in defaults must be an object (or absent) in the raw
// input, and unknown keys are reported.
const checkShape = (
  raw: unknown,
  defaults: PlainObject,
  path: string,
  issues: ConfigIssue[],
): void => {
  if (raw === undefined) return;
  if (!isPlainObject(raw)) {
    issues.push({ path: path || '<root>', message: 'must be an object' });
    return;
  }
  for (const key of Object.keys(raw)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (!(key in defaults)) {
      issues.push({ path: fullPath, message: 'unknown key' });
      continue;
    }
    const defaultValue = defaults[key];
    if (isPlainObject(defaultValue)) {
      checkShape(raw[key], defaultValue, fullPath, issues);
    }
  }
};

// Splits `provider/model` into its parts; `inherit` and malformed ids give
// undefined.
export const parseModelId = (
  model: string,
): { provider: string; modelId: string } | undefined => {
  const slash = model.indexOf('/');
  const valid = model !== INHERIT && slash > 0 && slash !== model.length - 1;
  return valid
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : undefined;
};

const validateRole = (
  path: string,
  role: RoleConfig,
  issues: ConfigIssue[],
): void => {
  if (typeof role.model !== 'string' || role.model.trim() === '') {
    issues.push({
      path: `${path}.model`,
      message: 'must be a non-empty string',
    });
  } else if (role.model !== INHERIT && !parseModelId(role.model)) {
    issues.push({
      path: `${path}.model`,
      message: 'must be "inherit" or provider/model',
    });
  }
  if (!THINKING_LEVELS.includes(role.thinking)) {
    issues.push({
      path: `${path}.thinking`,
      message: `must be one of ${THINKING_LEVELS.join(', ')}`,
    });
  }
  const { timeoutMs } = role;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    issues.push({
      path: `${path}.timeoutMs`,
      message: 'must be a positive int',
    });
  } else if (timeoutMs > MAX_TIMEOUT_MS) {
    issues.push({
      path: `${path}.timeoutMs`,
      message: `max ${MAX_TIMEOUT_MS}`,
    });
  }
};

const validateDir = (
  path: string,
  value: string,
  issues: ConfigIssue[],
): void => {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: 'must be a non-empty string' });
  } else if (value.startsWith('/') || value.split(/[\\/]/).includes('..')) {
    issues.push({ path, message: 'must be a relative path without ..' });
  }
};

// ralph state must live outside the project: `~/x` or an absolute path.
const validateStateDir = (
  path: string,
  value: string | undefined,
  issues: ConfigIssue[],
): void => {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: 'must be a non-empty string' });
  } else if (!(value.startsWith('~/') || value.startsWith('/'))) {
    issues.push({ path, message: 'must start with ~/ or / (outside cwd)' });
  } else if (value.split(/[\\/]/).includes('..')) {
    issues.push({ path, message: 'must not contain ..' });
  }
};

export const validateConfig = (config: SpiralConfig): ConfigIssue[] => {
  const issues: ConfigIssue[] = [];
  const { ralplan, ralph } = config;
  if (!['forward', 'deny'].includes(config.permissionAsks)) {
    issues.push({
      path: 'permissionAsks',
      message: 'must be forward | deny',
    });
  }
  const { maxIterations } = ralplan;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    issues.push({ path: 'ralplan.maxIterations', message: 'must be >= 1' });
  } else if (maxIterations > RALPLAN_MAX_ITERATIONS) {
    issues.push({
      path: 'ralplan.maxIterations',
      message: `must be <= ${RALPLAN_MAX_ITERATIONS}`,
    });
  }
  validateDir('ralplan.plansDir', ralplan.plansDir, issues);
  if (!['auto', 'always', 'never'].includes(ralplan.deliberate)) {
    issues.push({
      path: 'ralplan.deliberate',
      message: 'must be auto | always | never',
    });
  }
  validateRole('ralplan.roles.planner', ralplan.roles.planner, issues);
  validateRole('ralplan.roles.architect', ralplan.roles.architect, issues);
  validateRole('ralplan.roles.critic', ralplan.roles.critic, issues);
  if (!Number.isInteger(ralph.maxIterations) || ralph.maxIterations < 1) {
    issues.push({ path: 'ralph.maxIterations', message: 'must be >= 1' });
  } else if (ralph.maxIterations > RALPH_MAX_ITERATIONS) {
    issues.push({
      path: 'ralph.maxIterations',
      message: `must be <= ${RALPH_MAX_ITERATIONS}`,
    });
  }
  validateStateDir('ralph.stateDir', ralph.stateDir, issues);
  if (typeof ralph.deslop !== 'boolean') {
    issues.push({ path: 'ralph.deslop', message: 'must be a boolean' });
  }
  if (!['critic', 'architect'].includes(ralph.reviewerAgent)) {
    issues.push({
      path: 'ralph.reviewerAgent',
      message: 'must be critic | architect',
    });
  }
  const { maxReviewAttempts } = ralph;
  if (
    !Number.isInteger(maxReviewAttempts) ||
    maxReviewAttempts < 1 ||
    maxReviewAttempts > RALPH_MAX_REVIEW_ATTEMPTS
  ) {
    issues.push({
      path: 'ralph.maxReviewAttempts',
      message: `must be an int in 1..${RALPH_MAX_REVIEW_ATTEMPTS}`,
    });
  }
  if (
    !Array.isArray(ralph.verify) ||
    !ralph.verify.every((cmd) => typeof cmd === 'string' && cmd.trim() !== '')
  ) {
    issues.push({
      path: 'ralph.verify',
      message: 'must be an array of non-empty command strings',
    });
  }
  const { verifyTimeoutMs } = ralph;
  if (
    !Number.isInteger(verifyTimeoutMs) ||
    verifyTimeoutMs <= 0 ||
    verifyTimeoutMs > MAX_TIMEOUT_MS
  ) {
    issues.push({
      path: 'ralph.verifyTimeoutMs',
      message: `must be a positive int <= ${MAX_TIMEOUT_MS}`,
    });
  }
  if (!Number.isSafeInteger(ralph.budgetTokens) || ralph.budgetTokens < 0) {
    issues.push({
      path: 'ralph.budgetTokens',
      message: 'must be an int >= 0 (0 = off)',
    });
  }
  validateRole('ralph.roles.prd', ralph.roles.prd, issues);
  validateRole('ralph.roles.executor', ralph.roles.executor, issues);
  validateRole('ralph.roles.reviewer', ralph.roles.reviewer, issues);
  validateRole('ralph.roles.cleaner', ralph.roles.cleaner, issues);
  return issues;
};

const PRESET_NAME = /^[a-z0-9][a-z0-9-]*$/;

const ROLE_SHAPE = { model: '', thinking: '', timeoutMs: 0 };

// Allowed keys in a preset; leaf values are placeholders for checkShape.
const PRESET_SHAPE: PlainObject = {
  ralplan: {
    maxIterations: 0,
    deliberate: '',
    roles: {
      planner: ROLE_SHAPE,
      architect: ROLE_SHAPE,
      critic: ROLE_SHAPE,
    },
  },
  ralph: {
    maxIterations: 0,
    deslop: false,
    reviewerAgent: '',
    maxReviewAttempts: 0,
    budgetTokens: 0,
    roles: {
      prd: ROLE_SHAPE,
      executor: ROLE_SHAPE,
      reviewer: ROLE_SHAPE,
      cleaner: ROLE_SHAPE,
    },
  },
};

export const applyPreset = (
  config: SpiralConfig,
  preset: Preset,
): SpiralConfig => deepMerge(config, preset);

export interface PresetCatalog {
  presets: Record<string, Preset>;
  presetSources: Record<string, PresetSource>;
  // session-independent default from the config files
  defaultPreset?: string;
}

export const builtinCatalog = (): PresetCatalog => ({
  presets: { ...BUILTIN_PRESETS },
  presetSources: Object.fromEntries(
    Object.keys(BUILTIN_PRESETS).map((name) => [name, 'built-in' as const]),
  ),
});

// Preset names a user can pick, `default` first.
export const presetNames = (catalog: PresetCatalog): string[] => [
  DEFAULT_PRESET,
  ...Object.keys(catalog.presets).sort(),
];

// Every preset applied onto `base` must be a valid config. Issues already
// present in `base` are not blamed on the preset.
const validatePresets = (
  base: SpiralConfig,
  presets: Record<string, Preset>,
  issues: ConfigIssue[],
): void => {
  const known = new Set(
    validateConfig(base).map((i) => `${i.path}\0${i.message}`),
  );
  for (const [name, preset] of Object.entries(presets)) {
    const merged = applyPreset(base, preset);
    for (const issue of validateConfig(merged)) {
      if (known.has(`${issue.path}\0${issue.message}`)) continue;
      issues.push({
        path: `presets.${name}.${issue.path}`,
        message: issue.message,
      });
    }
  }
};

const isKnownPreset = (catalog: PresetCatalog, name: string): boolean =>
  name === DEFAULT_PRESET || Object.hasOwn(catalog.presets, name);

export interface PresetSelection {
  // explicit per-run choice (`--preset`, tool param); `default` = none
  requested?: string;
  // `/spiral-preset` choice for this session; ignored when stale
  session?: string;
}

export interface ResolvedPreset {
  config: SpiralConfig;
  // undefined = base config
  preset: string | undefined;
  error?: string;
}

// Precedence: requested > session > defaultPreset > none. Per-role model
// flags are applied by the callers on top of the returned config.
export const resolvePreset = (
  config: SpiralConfig,
  catalog: PresetCatalog,
  selection: PresetSelection = {},
): ResolvedPreset => {
  const { requested, session } = selection;
  let name: string | undefined;
  if (requested !== undefined) {
    if (!isKnownPreset(catalog, requested)) {
      return {
        config,
        preset: undefined,
        error: `unknown preset "${requested}"; available: ${presetNames(
          catalog,
        ).join(', ')}`,
      };
    }
    name = requested;
  } else if (session !== undefined && isKnownPreset(catalog, session)) {
    name = session;
  } else {
    name = catalog.defaultPreset;
  }
  if (name === undefined || name === DEFAULT_PRESET) {
    return { config, preset: undefined };
  }
  return { config: applyPreset(config, catalog.presets[name]), preset: name };
};

export interface LoadedConfig extends PresetCatalog {
  config: SpiralConfig;
  sources: string[];
  issues: ConfigIssue[];
  // true when issues were found and DEFAULT_CONFIG is in effect instead
  fallback: boolean;
}

export interface LoadOptions {
  // pi's CONFIG_DIR_NAME (".pi"); a parameter so tests need no pi import
  configDirName?: string;
  // untrusted projects never contribute config (ctx.isProjectTrusted())
  projectTrusted?: boolean;
  // pi's agent dir (getAgentDir(), honors PI_CODING_AGENT_DIR); default
  // `<homeDir>/<configDirName>/agent`
  agentDir?: string;
  // home directory override so tests do not read the real user config
  homeDir?: string;
}

const readConfigFile = (path: string, issues: ConfigIssue[]): unknown => {
  let parsed: unknown;
  if (!existsSync(path)) return parsed;
  try {
    parsed = parseJsonc(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ path, message: `cannot parse: ${message}` });
  }
  return parsed;
};

// `presets` and `defaultPreset` live beside the config keys but are not part
// of SpiralConfig; they are peeled off before the shape check and merge.
const splitPresetKeys = (
  raw: unknown,
): { presets: unknown; defaultPreset: unknown; rest: unknown } => {
  if (!isPlainObject(raw)) {
    return { presets: undefined, defaultPreset: undefined, rest: raw };
  }
  const { presets, defaultPreset, ...rest } = raw;
  return { presets, defaultPreset, rest };
};

// Same-named presets replace each other whole (built-in < user < project).
const mergePresets = (
  catalog: PresetCatalog,
  raw: unknown,
  source: PresetSource,
  issues: ConfigIssue[],
): void => {
  if (raw === undefined) return;
  if (!isPlainObject(raw)) {
    issues.push({ path: 'presets', message: 'must be an object' });
    return;
  }
  for (const [name, preset] of Object.entries(raw)) {
    const path = `presets.${name}`;
    if (name === DEFAULT_PRESET) {
      issues.push({ path, message: `"${DEFAULT_PRESET}" is reserved` });
    } else if (!PRESET_NAME.test(name)) {
      issues.push({ path, message: 'name must match [a-z0-9][a-z0-9-]*' });
    } else {
      const before = issues.length;
      checkShape(preset, PRESET_SHAPE, path, issues);
      if (issues.length === before) {
        catalog.presets[name] = preset as Preset;
        catalog.presetSources[name] = source;
      }
    }
  }
};

// Fail-closed: any parse, shape or value issue makes the whole result fall
// back to DEFAULT_CONFIG. Callers show `issues` and must refuse to run the
// loop when `fallback` is set unless the user explicitly accepts defaults.
export const loadConfig = (
  cwd: string,
  options: LoadOptions = {},
): LoadedConfig => {
  const configDirName = options.configDirName ?? '.pi';
  const sources: string[] = [];
  const issues: ConfigIssue[] = [];
  const agentDir =
    options.agentDir ?? defaultAgentDir(configDirName, options.homeDir);
  const paths = [getUserConfigPath(agentDir)];
  if (options.projectTrusted !== false) {
    paths.push(getProjectConfigPath(cwd, configDirName));
  }
  let config: SpiralConfig = DEFAULT_CONFIG;
  const catalog = builtinCatalog();
  const sourceKinds: PresetSource[] = ['user', 'project'];
  for (const [index, path] of paths.entries()) {
    const raw = readConfigFile(path, issues);
    if (raw === undefined) continue;
    sources.push(path);
    const { presets, defaultPreset, rest } = splitPresetKeys(raw);
    mergePresets(catalog, presets, sourceKinds[index], issues);
    if (defaultPreset !== undefined) {
      if (typeof defaultPreset === 'string') {
        catalog.defaultPreset = defaultPreset;
      } else {
        issues.push({ path: 'defaultPreset', message: 'must be a string' });
      }
    }
    checkShape(rest, DEFAULT_CONFIG as unknown as PlainObject, '', issues);
    config = deepMerge(config, rest);
  }
  issues.push(...validateConfig(config));
  if (issues.length === 0) {
    validatePresets(config, catalog.presets, issues);
    const { defaultPreset } = catalog;
    if (defaultPreset !== undefined && !isKnownPreset(catalog, defaultPreset)) {
      issues.push({
        path: 'defaultPreset',
        message: `unknown preset "${defaultPreset}"`,
      });
    }
  }
  if (issues.length > 0) {
    // presets are kept (built-ins only) so `/spiral-preset` still lists them
    return {
      config: DEFAULT_CONFIG,
      sources,
      issues,
      fallback: true,
      ...builtinCatalog(),
    };
  }
  return { config, sources, issues, fallback: false, ...catalog };
};
