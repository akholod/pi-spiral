// Thin adapter from Spiral's delegation contract to pi-agent-runner: maps a
// role name to its prompt and tools, runs the child with `runAgent` and
// reshapes the outcome into a DelegationResponse. The response shape is kept
// because the loops and responses.ts are written against it.

import {
  runAgent,
  type ParentContext,
  type RunAgentResult,
} from 'pi-agent-runner';
import type { PermissionAsks, ThinkingLevel } from '../config.ts';
import { readRolePrompt, ROLE_DEFINITIONS, roleForAgent } from './roles.ts';

export type DelegationResultRequest =
  { kind: 'text' } | { kind: 'structured'; schema: Record<string, unknown> };

export type DelegationStatus = RunAgentResult['status'] | 'invalid_request';

export type DelegationValue =
  { kind: 'text'; text: string } | { kind: 'structured'; value: unknown };

export interface DelegationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
  waitedMs: number;
}

export interface DelegationResponse {
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
  status: DelegationStatus;
  error?: string;
  model?: string;
  thinking?: string;
  result?: DelegationValue;
  usage?: DelegationUsage;
}

export interface DelegationUpdate {
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
  currentTool?: string;
  recentOutput?: string;
  durationMs?: number;
  tokens?: number;
}

export interface DelegateOptions {
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  timeoutMs: number;
  result: DelegationResultRequest;
  permissionAsks: PermissionAsks;
  signal?: AbortSignal;
  onUpdate?: (update: DelegationUpdate) => void;
}

// Seam for tests: the runner is replaceable.
export interface DelegateDeps {
  runAgent?: typeof runAgent;
}

// Runs one foreground child and resolves with its terminal response. Never
// rejects for run outcomes; they are reported through `status`.
export const delegate = async (
  parent: ParentContext,
  options: DelegateOptions,
  deps: DelegateDeps = {},
): Promise<DelegationResponse> => {
  const run = deps.runAgent ?? runAgent;
  const requestId = crypto.randomUUID();
  const { ownerRunId, nodeId } = options;
  const role = roleForAgent(options.agent);
  if (!role) {
    return {
      requestId,
      ownerRunId,
      nodeId,
      status: 'invalid_request',
      error: `unknown agent ${options.agent}`,
    };
  }
  const { tools } = ROLE_DEFINITIONS[role];
  const outcome = await run({
    parent,
    cwd: options.cwd,
    systemPrompt: readRolePrompt(role),
    task: options.task,
    tools: tools ? [...tools] : undefined,
    model: options.model,
    thinking: options.thinking,
    extensions: 'none',
    result: options.result,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    permissionAsks: options.permissionAsks,
    onUpdate: (update) =>
      options.onUpdate?.({
        requestId,
        ownerRunId,
        nodeId,
        currentTool: update.tool,
        recentOutput: update.recentOutput,
        durationMs: update.durationMs,
        tokens: update.tokens,
      }),
  });
  const response: DelegationResponse = {
    requestId,
    ownerRunId,
    nodeId,
    status: outcome.status,
    model: outcome.model,
    thinking: options.thinking,
    usage: {
      input: outcome.usage.input,
      output: outcome.usage.output,
      cacheRead: outcome.usage.cacheRead,
      cacheWrite: outcome.usage.cacheWrite,
      cost: outcome.usage.cost,
      turns: outcome.usage.turns,
      toolCalls: outcome.usage.toolCalls,
      durationMs: outcome.usage.durationMs,
      waitedMs: outcome.usage.waitedMs,
    },
  };
  if (outcome.error !== undefined) response.error = outcome.error;
  if (outcome.status === 'completed') {
    response.result =
      options.result.kind === 'text'
        ? { kind: 'text', text: String(outcome.value) }
        : { kind: 'structured', value: outcome.value };
  }
  return response;
};
