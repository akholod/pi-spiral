// Phase 2: ralph — PRD-driven persistence loop.
//
// Reference: oh-my-claudecode/skills/ralph/SKILL.md. Planned shape:
//   1. Take an approved ralplan artifact (or a task) and derive prd.json with
//      user stories + testable acceptance criteria.
//   2. Loop: pick next story with passes=false -> executor child implements
//      -> verify criteria with fresh evidence -> mark passes=true.
//   3. When all stories pass, reviewer child verifies against the criteria;
//      on rejection loop back.
//   4. State in `.spiral/ralph/<run>/{prd.json,progress.md}`.
//
// Nothing here is wired yet; the config shape (`ralph` in spiral.json) is
// already reserved so that phase 2 does not need a config migration.

import type { RalphConfig } from '../config.ts';

export interface RalphStory {
  id: string;
  title: string;
  acceptanceCriteria: string[];
  passes: boolean;
  reviewerVerified: boolean;
  notes: string[];
}

export interface RalphPrd {
  task: string;
  planArtifact?: string;
  stories: RalphStory[];
}

export const describeRalph = (config: RalphConfig): string =>
  `ralph is not implemented yet (max ${config.maxIterations} iterations, ` +
  `executor=${config.roles.executor.model}, reviewer=${config.roles.reviewer.model})`;
