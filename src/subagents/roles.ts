// Spiral's role table: which child agent each role runs as, the tools it may
// use and the prompt it is given. Prompts live in agents/<role>.md.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_PREFIX = 'spiral';

// ralplan roles; all three are read-only reviewers/planners.
export type RoleName = 'planner' | 'architect' | 'critic';

// Every agent Spiral delegates to. ralph reuses planner (PRD drafting) and
// critic/architect (verification) and adds two writers.
export type AgentName = RoleName | 'executor' | 'cleaner';

export const ROLE_AGENT_NAMES: Record<AgentName, string> = {
  planner: `${AGENT_PREFIX}-planner`,
  architect: `${AGENT_PREFIX}-architect`,
  critic: `${AGENT_PREFIX}-critic`,
  executor: `${AGENT_PREFIX}-executor`,
  cleaner: `${AGENT_PREFIX}-cleaner`,
};

// No `bash`: a tool allowlist is the only boundary a child gets (not an OS
// sandbox), so a shell would let a role mutate the project or run git.
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

export interface RoleDefinition {
  description: string;
  // undefined = pi's normal builtin tools (read, write, edit, bash, ...)
  tools?: readonly string[];
}

export const ROLE_DEFINITIONS: Record<AgentName, RoleDefinition> = {
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
      'Spiral executor: implements one ralph user story end to end (writes ' +
      'code, runs checks)',
  },
  cleaner: {
    description:
      'Spiral cleaner: bounded, regression-safe AI-slop cleanup of the ' +
      'files a ralph run changed',
  },
};

const agentsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agents',
);

// Trimmed, as the prompts have always been delivered (the files end with a
// newline).
export const readRolePrompt = (role: AgentName): string =>
  readFileSync(join(agentsDir, `${role}.md`), 'utf8').trim();

export const roleForAgent = (agentName: string): AgentName | undefined =>
  (Object.keys(ROLE_AGENT_NAMES) as AgentName[]).find(
    (role) => ROLE_AGENT_NAMES[role] === agentName,
  );
