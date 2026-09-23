// Pre-run checks on the resolved role models, done before any child is
// launched so a misconfigured provider fails fast instead of after the
// first expensive planner run.

import { INHERIT, parseModelId, type RalplanConfig } from '../config.ts';
import type { RoleName } from '../subagents/register-agents.ts';

// The subset of pi's ModelRegistry that preflight needs (testable without pi).
export interface ModelLookup {
  find(provider: string, modelId: string): unknown | undefined;
  hasConfiguredAuth(model: never): boolean;
}

export interface PreflightResult {
  // fatal: a configured model does not exist or has no auth
  errors: string[];
  // advisory, shown once per session
  warnings: string[];
}

export const preflightModels = (
  config: RalplanConfig,
  registry: ModelLookup,
): PreflightResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const role of Object.keys(config.roles) as RoleName[]) {
    const { model } = config.roles[role];
    if (model === INHERIT) continue;
    const parsed = parseModelId(model);
    if (!parsed) {
      errors.push(`${role}: "${model}" is not provider/model`);
      continue;
    }
    const found = registry.find(parsed.provider, parsed.modelId);
    if (!found) {
      errors.push(`${role}: model "${model}" is not known to pi`);
    } else if (!registry.hasConfiguredAuth(found as never)) {
      errors.push(`${role}: no credentials configured for "${model}"`);
    }
  }
  const { critic, planner } = config.roles;
  const sameAsPlanner =
    critic.model === planner.model ||
    (critic.model === INHERIT && planner.model === INHERIT);
  if (sameAsPlanner) {
    warnings.push(
      'critic runs on the same model as the planner; set ' +
        'ralplan.roles.critic.model to a different provider for an ' +
        'independent second opinion',
    );
  }
  return { errors, warnings };
};
