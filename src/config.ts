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
  // loop iterations: story attempts + review rounds
  maxIterations: number;
  stateDir: string;
  // post-approval ai-slop-cleaner pass on changed files (OMC step 7.5)
  deslop: boolean;
  reviewerAgent: ReviewerAgent;
  // reviewer rounds before giving up (OMC max_verification_attempts)
  maxReviewAttempts: number;
  // regression commands the loop runs itself; empty = use the PRD's list
  verify: string[];
  verifyTimeoutMs: number;
  roles: {
    // drafts prd.json (planner agent, read-only)
    prd: RoleConfig;
    executor: RoleConfig;
    reviewer: RoleConfig;
    cleaner: RoleConfig;
  };
}

export interface SpiralConfig {
  ralplan: RalplanConfig;
  ralph: RalphConfig;
}

// `inherit` = the model of the pi session that runs the command. Built-in
// defaults never name a provider so the package works on any install; the
// recommended Opus/GPT profile lives in spiral.config.example.jsonc.
export const INHERIT = 'inherit';

// Hard limits. RALPLAN_MAX_ITERATIONS mirrors the OMC reference (5 rounds).
// MAX_TIMEOUT_MS is the pi-subagents delegation API cap.
export const RALPLAN_MAX_ITERATIONS = 5;
export const RALPH_MAX_ITERATIONS = 100;
export const RALPH_MAX_REVIEW_ATTEMPTS = 10;
export const MAX_TIMEOUT_MS = 2_147_483_647;

export const DEFAULT_CONFIG: SpiralConfig = {
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
    stateDir: '.spiral/ralph',
    deslop: true,
    reviewerAgent: 'critic',
    maxReviewAttempts: 3,
    verify: [],
    verifyTimeoutMs: 600_000,
    roles: {
      prd: { model: INHERIT, thinking: 'high', timeoutMs: 900_000 },
      executor: { model: INHERIT, thinking: 'medium', timeoutMs: 1_800_000 },
      reviewer: { model: INHERIT, thinking: 'high', timeoutMs: 900_000 },
      cleaner: { model: INHERIT, thinking: 'medium', timeoutMs: 1_200_000 },
    },
  },
};

export const CONFIG_FILE_NAME = 'spiral.json';

export const getUserConfigPath = (
  configDirName: string,
  homeDir = homedir(),
): string => join(homeDir, configDirName, 'agent', CONFIG_FILE_NAME);

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
      if (text[j] === '}' || text[j] === ']') i++;
      else ((out += ch), i++);
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
  if (model === INHERIT) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
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

export const validateConfig = (config: SpiralConfig): ConfigIssue[] => {
  const issues: ConfigIssue[] = [];
  const { ralplan, ralph } = config;
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
  validateDir('ralph.stateDir', ralph.stateDir, issues);
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
  validateRole('ralph.roles.prd', ralph.roles.prd, issues);
  validateRole('ralph.roles.executor', ralph.roles.executor, issues);
  validateRole('ralph.roles.reviewer', ralph.roles.reviewer, issues);
  validateRole('ralph.roles.cleaner', ralph.roles.cleaner, issues);
  return issues;
};

export interface LoadedConfig {
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
  // home directory override so tests do not read the real user config
  homeDir?: string;
}

const readConfigFile = (path: string, issues: ConfigIssue[]): unknown => {
  if (!existsSync(path)) return undefined;
  try {
    return parseJsonc(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ path, message: `cannot parse: ${message}` });
    return undefined;
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
  const paths = [getUserConfigPath(configDirName, options.homeDir)];
  if (options.projectTrusted !== false) {
    paths.push(getProjectConfigPath(cwd, configDirName));
  }
  let config: SpiralConfig = DEFAULT_CONFIG;
  for (const path of paths) {
    const raw = readConfigFile(path, issues);
    if (raw === undefined) continue;
    sources.push(path);
    checkShape(raw, DEFAULT_CONFIG as unknown as PlainObject, '', issues);
    config = deepMerge(config, raw);
  }
  issues.push(...validateConfig(config));
  if (issues.length > 0) {
    return { config: DEFAULT_CONFIG, sources, issues, fallback: true };
  }
  return { config, sources, issues, fallback: false };
};
