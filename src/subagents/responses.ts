// Shared handling of pi-subagents delegation responses: failure and
// cancellation classification, result extraction and usage aggregation.
// Both workflows (ralplan, ralph) build on these.

import type { DelegationResponse } from './delegation.ts';

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
  // number of child runs that reported usage
  runs: number;
}

export const emptyUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  toolCalls: 0,
  durationMs: 0,
  runs: 0,
});

export const addUsage = (
  total: UsageTotals,
  response: DelegationResponse,
): void => {
  const { usage } = response;
  if (!usage) return;
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.cost += usage.cost;
  total.turns += usage.turns;
  total.toolCalls += usage.toolCalls;
  total.durationMs += usage.durationMs;
  total.runs++;
};

export class RoleFailure extends Error {
  constructor(role: string, detail: string) {
    super(`${role} ${detail}`);
    this.name = 'RoleFailure';
  }
}

// Raised when a child ended because of cancellation (ours or the user's
// interrupt) so a loop reports `aborted`, not `failed`.
export class Cancelled extends Error {
  constructor(role: string) {
    super(`${role} cancelled`);
    this.name = 'Cancelled';
  }
}

const CANCEL_STATUSES = new Set(['cancelled', 'interrupted']);

export const failureDetail = (response: DelegationResponse): string =>
  response.status + (response.error ? `: ${response.error}` : '');

export const ensureNotCancelled = (
  role: string,
  response: DelegationResponse,
): void => {
  if (CANCEL_STATUSES.has(response.status)) throw new Cancelled(role);
};

export const textOf = (role: string, response: DelegationResponse): string => {
  ensureNotCancelled(role, response);
  if (response.status !== 'completed' || response.result?.kind !== 'text') {
    throw new RoleFailure(role, failureDetail(response));
  }
  const text = response.result.text.trim();
  if (text === '') throw new RoleFailure(role, 'returned an empty response');
  return text;
};

// Returns the structured value; the caller validates its shape.
export const structuredOf = (
  role: string,
  response: DelegationResponse,
): unknown => {
  ensureNotCancelled(role, response);
  if (
    response.status !== 'completed' ||
    response.result?.kind !== 'structured'
  ) {
    throw new RoleFailure(role, failureDetail(response));
  }
  return response.result.value;
};
