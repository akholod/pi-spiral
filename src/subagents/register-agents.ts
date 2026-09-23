// Registers Spiral's role agents with pi-subagents at runtime through the
// process-local `pi-subagents:runtime-agent-register:v1` event, so the
// package does not have to ship files into the operator's agents directory.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const RUNTIME_AGENT_REGISTER_EVENT =
  'pi-subagents:runtime-agent-register:v1';

export const AGENT_PREFIX = 'spiral';

// ralplan roles; all three are read-only reviewers/planners.
export type RoleName = 'planner' | 'architect' | 'critic';

// Every agent Spiral registers. ralph reuses planner (PRD drafting) and
// critic/architect (verification) and adds two writers.
export type AgentName = RoleName | 'executor' | 'cleaner';

export const ROLE_AGENT_NAMES: Record<AgentName, string> = {
  planner: `${AGENT_PREFIX}-planner`,
  architect: `${AGENT_PREFIX}-architect`,
  critic: `${AGENT_PREFIX}-critic`,
  executor: `${AGENT_PREFIX}-executor`,
  cleaner: `${AGENT_PREFIX}-cleaner`,
};

// No `bash`: tool restrictions are the only boundary pi-subagents gives us
// (not an OS sandbox), so a shell would let a role mutate the project or run
// git. Roles get exactly the pi-subagents documented read-only set.
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

interface RoleDefinition {
  description: string;
  // omitted = pi's normal builtin tools (read, write, edit, bash, ...)
  tools?: readonly string[];
}

const ROLE_DEFINITIONS: Record<AgentName, RoleDefinition> = {
  planner: {
    description:
      'Spiral planner: drafts and revises RALPLAN-DR work plans (read-only)',
    tools: READ_ONLY_TOOLS,
  },
  architect: {
    description:
      'Spiral architect: steelman antithesis and tradeoff review of a plan',
    tools: READ_ONLY_TOOLS,
  },
  critic: {
    description:
      'Spiral critic: final quality gate returning APPROVE | ITERATE | REJECT',
    tools: READ_ONLY_TOOLS,
  },
  executor: {
    description:
      'Spiral executor: implements one ralph user story end to end (writes code, runs checks)',
  },
  cleaner: {
    description:
      'Spiral cleaner: bounded, regression-safe AI-slop cleanup of the files a ralph run changed',
  },
};

interface RegisterRequest {
  version: 1;
  name: string;
  definition: {
    description: string;
    systemPrompt: string;
    tools?: readonly string[];
  };
  result?:
    | { ok: true; registration: { dispose(): void } }
    | { ok: false; error: Error };
}

export interface Disposable {
  dispose(): void;
}

const agentsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agents',
);

export const readRolePrompt = (role: AgentName): string =>
  readFileSync(join(agentsDir, `${role}.md`), 'utf8');

const registerOne = (pi: ExtensionAPI, role: AgentName): Disposable => {
  const definition = ROLE_DEFINITIONS[role];
  const request: RegisterRequest = {
    version: 1,
    name: ROLE_AGENT_NAMES[role],
    definition: {
      description: definition.description,
      systemPrompt: readRolePrompt(role),
      tools: definition.tools,
    },
  };
  pi.events.emit(RUNTIME_AGENT_REGISTER_EVENT, request);
  if (!request.result) {
    throw new Error('pi-subagents is not installed or not ready');
  }
  if (!request.result.ok) throw request.result.error;
  return request.result.registration;
};

export const registerRoleAgents = (pi: ExtensionAPI): Disposable => {
  const registrations: Disposable[] = [];
  try {
    for (const role of Object.keys(ROLE_DEFINITIONS) as AgentName[]) {
      registrations.push(registerOne(pi, role));
    }
  } catch (error) {
    for (const registration of registrations) registration.dispose();
    throw error;
  }
  return {
    dispose: () => {
      for (const registration of registrations) registration.dispose();
    },
  };
};
