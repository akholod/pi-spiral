// Pre-run checks on resolved role models, done before any child is
// launched so a misconfigured provider fails fast instead of after the
// first expensive child run. Shared by ralplan and ralph.

import { INHERIT, parseModelId, type RoleConfig } from '../config.ts';

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

// `independent` names two roles that should not share a model (author and
// reviewer); a shared model is a warning, not an error.
export const preflightModels = (
  roles: Record<string, RoleConfig>,
  registry: ModelLookup,
  independent?: [string, string],
): PreflightResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [role, { model }] of Object.entries(roles)) {
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
  if (independent) {
    const [author, reviewer] = independent;
    if (roles[author]?.model === roles[reviewer]?.model) {
      warnings.push(
        `${reviewer} runs on the same model as the ${author}; set ` +
          `roles.${reviewer}.model to a different provider for an ` +
          'independent second opinion',
      );
    }
  }
  return { errors, warnings };
};
