import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RalplanConfig } from '../config.ts';
import type { RoleName } from '../subagents/register-agents.ts';
import {
  buildArtifactPath,
  renderArtifact,
  writeArtifact,
} from './artifact.ts';
import { runRalplanLoop, type Delegate, type LoopProgress } from './loop.ts';
import { detectPlanMode } from './prompts.ts';
import type { CheckpointHandler, RalplanResult } from './types.ts';

// Per-run model overrides, the pi equivalent of OMC's `--critic codex`.
export type RoleModelOverrides = Partial<Record<RoleName, string>>;

export interface RalplanOptions {
  pi: ExtensionAPI;
  config: RalplanConfig;
  cwd: string;
  task: string;
  deliberate?: boolean;
  // requires onCheckpoint; ignored (with a warning from the caller) otherwise
  interactive?: boolean;
  onCheckpoint?: CheckpointHandler;
  models?: RoleModelOverrides;
  signal?: AbortSignal;
  onProgress?: (progress: LoopProgress) => void;
  delegateFn?: Delegate;
}

export const applyModelOverrides = (
  config: RalplanConfig,
  models: RoleModelOverrides | undefined,
): RalplanConfig => {
  if (!models) return config;
  const roles = { ...config.roles };
  for (const role of Object.keys(roles) as RoleName[]) {
    const model = models[role];
    if (model) roles[role] = { ...roles[role], model };
  }
  return { ...config, roles };
};

export const runRalplan = async (
  options: RalplanOptions,
): Promise<RalplanResult> => {
  const config = applyModelOverrides(options.config, options.models);
  const mode = options.deliberate
    ? 'deliberate'
    : detectPlanMode(options.task, config.deliberate);
  const request = {
    runId: crypto.randomUUID(),
    task: options.task,
    cwd: options.cwd,
    mode,
    interactive: options.interactive === true && !!options.onCheckpoint,
  };
  const partial = await runRalplanLoop({
    pi: options.pi,
    config,
    request,
    signal: options.signal,
    onProgress: options.onProgress,
    onCheckpoint: options.onCheckpoint,
    delegateFn: options.delegateFn,
  });
  const result: RalplanResult = { ...partial };
  // Only outcomes with a plan produce a file; a user rejection or an early
  // failure leaves nothing on disk so a stale artifact cannot be mistaken
  // for a reviewed plan.
  if (partial.finalPlan !== '' && partial.outcome !== 'rejected') {
    const artifactPath = buildArtifactPath(
      options.cwd,
      config.plansDir,
      options.task,
    );
    writeArtifact(artifactPath, renderArtifact(request, result));
    result.artifactPath = artifactPath;
  }
  return result;
};

export interface ParsedRalplanArgs {
  task: string;
  deliberate: boolean;
  interactive: boolean;
  models: RoleModelOverrides;
  errors: string[];
}

const ROLE_FLAGS: Record<string, RoleName> = {
  '--planner': 'planner',
  '--architect': 'architect',
  '--critic': 'critic',
};

// `/ralplan [--deliberate] [--interactive] [--planner m] [--architect m]
// [--critic m] <task>`. Model flags take a full `provider/model` id.
export const parseRalplanArgs = (raw: string): ParsedRalplanArgs => {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const parsed: ParsedRalplanArgs = {
    task: '',
    deliberate: false,
    interactive: false,
    models: {},
    errors: [],
  };
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '--deliberate') parsed.deliberate = true;
    else if (word === '--interactive') parsed.interactive = true;
    else if (word in ROLE_FLAGS) {
      const value = words[i + 1];
      if (!value || value.startsWith('--')) {
        parsed.errors.push(`${word} requires a provider/model id`);
      } else {
        parsed.models[ROLE_FLAGS[word]] = value;
        i++;
      }
    } else rest.push(word);
  }
  parsed.task = rest.join(' ');
  return parsed;
};
