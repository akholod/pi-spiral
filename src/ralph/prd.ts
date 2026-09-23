// PRD model for ralph, ported from oh-my-claudecode's src/hooks/ralph/prd.ts.
// The loop owns prd.json: children never edit it, every mutation goes
// through the functions below so completion and amendment invariants hold.
// OMC's criteria-revision digests are not needed because no model can
// touch the file behind the loop's back.

export type AmendmentKind = 'replaced' | 'superseded';

// Evidence-preserving record of a criterion that no longer governs a story.
// The original text is retained verbatim forever (OMC ADR 03664).
export interface CriterionAmendment {
  kind: AmendmentKind;
  original: string;
  replacement?: string;
  reason: string;
  evidence: string;
  authority: string;
  timestamp: string;
}

export interface AmendmentInput {
  kind: AmendmentKind;
  original: string;
  replacement?: string;
  reason: string;
  evidence: string;
}

export interface Story {
  id: string;
  title: string;
  description: string;
  // currently governing criteria only
  acceptanceCriteria: string[];
  criterionAmendments: CriterionAmendment[];
  priority: number;
  // executor verified every active criterion with fresh evidence
  passes: boolean;
  // reviewer approved the whole PRD with this story in its current state
  reviewerVerified: boolean;
  attempts: number;
  notes: string[];
}

export interface Prd {
  project: string;
  branchName: string;
  description: string;
  planArtifact?: string;
  // regression commands proposed by the PRD planner (config may override)
  verify: string[];
  userStories: Story[];
}

export interface PrdStatus {
  total: number;
  passed: number;
  verified: number;
  pending: Story[];
  allPass: boolean;
  allVerified: boolean;
  next: Story | null;
}

export const MIN_EVIDENCE_LENGTH = 10;

// The scaffold criteria OMC warns about ("PRD theater"); a planner draft
// that still contains them is sent back.
const GENERIC_CRITERIA = [
  /^implementation is complete/i,
  /^code compiles/i,
  /^tests pass/i,
  /^changes are committed/i,
  /^it works/i,
  /^feature (is )?(done|complete|implemented)/i,
];

export const isGenericCriterion = (criterion: string): boolean =>
  GENERIC_CRITERIA.some((pattern) => pattern.test(criterion.trim()));

const byPriority = (a: Story, b: Story): number => a.priority - b.priority;

export const prdStatus = (prd: Prd): PrdStatus => {
  const stories = [...prd.userStories].sort(byPriority);
  const pending = stories.filter((story) => !story.passes);
  const passed = stories.length - pending.length;
  const verified = stories.filter(
    (story) => story.passes && story.reviewerVerified,
  ).length;
  return {
    total: stories.length,
    passed,
    verified,
    pending,
    allPass: pending.length === 0,
    allVerified: verified === stories.length,
    next: pending[0] ?? null,
  };
};

export const markStoryPassed = (story: Story, note: string): void => {
  story.passes = true;
  story.reviewerVerified = false;
  story.notes.push(note);
};

export const markStoryFailed = (story: Story, note: string): void => {
  story.passes = false;
  story.reviewerVerified = false;
  story.notes.push(note);
};

export type AmendmentError =
  | 'original-not-active'
  | 'reason-required'
  | 'evidence-too-short'
  | 'replacement-required'
  | 'replacement-not-allowed';

// Applies an amendment or returns a closed error code without mutating.
// A refuted criterion may leave the active list only through here.
export const amendCriterion = (
  story: Story,
  input: AmendmentInput,
  authority: string,
  timestamp = new Date().toISOString(),
): AmendmentError | null => {
  const original = input.original;
  const index = story.acceptanceCriteria.indexOf(original);
  if (index < 0) return 'original-not-active';
  if (story.criterionAmendments.some((a) => a.original === original)) {
    return 'original-not-active';
  }
  const reason = input.reason?.trim() ?? '';
  const evidence = input.evidence?.trim() ?? '';
  const replacement = input.replacement?.trim();
  if (reason === '') return 'reason-required';
  if (evidence.length < MIN_EVIDENCE_LENGTH) return 'evidence-too-short';
  if (input.kind === 'replaced' && !replacement) return 'replacement-required';
  if (input.kind === 'superseded' && input.replacement !== undefined) {
    return 'replacement-not-allowed';
  }
  const next = [...story.acceptanceCriteria];
  next.splice(index, 1);
  if (input.kind === 'replaced' && replacement) {
    next.splice(index, 0, replacement);
  }
  story.acceptanceCriteria = next;
  story.criterionAmendments.push({
    kind: input.kind,
    original,
    ...(input.kind === 'replaced' ? { replacement } : {}),
    reason,
    evidence,
    authority,
    timestamp,
  });
  story.passes = false;
  story.reviewerVerified = false;
  return null;
};

// Reviewer findings that map to no story become a story of their own so
// the PRD stays the single completion authority.
export const addReviewStory = (
  prd: Prd,
  round: number,
  criteria: string[],
): Story => {
  const priority =
    prd.userStories.reduce((max, s) => Math.max(max, s.priority), 0) + 1;
  const story: Story = {
    id: `RV-${String(round).padStart(3, '0')}`,
    title: `Reviewer findings, round ${round}`,
    description:
      'Address the blocking findings the reviewer raised on the completed PRD.',
    acceptanceCriteria: criteria,
    criterionAmendments: [],
    priority,
    passes: false,
    reviewerVerified: false,
    attempts: 0,
    notes: [],
  };
  prd.userStories.push(story);
  return story;
};

// ---------------------------------------------------------------------------
// Draft (planner output) -> Prd

export interface StoryDraft {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface PrdDraft {
  description: string;
  verify: string[];
  stories: StoryDraft[];
}

export const PRD_DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'verify', 'stories'],
  properties: {
    description: { type: 'string' },
    verify: { type: 'array', maxItems: 10, items: { type: 'string' } },
    stories: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description', 'acceptanceCriteria'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string' },
          },
        },
      },
    },
  },
};

// Returns problems a draft must fix before it becomes the PRD.
export const checkDraft = (draft: PrdDraft): string[] => {
  const problems: string[] = [];
  if (draft.stories.length === 0) problems.push('no user stories');
  const ids = new Set<string>();
  for (const story of draft.stories) {
    const id = story.id.trim();
    if (id === '') problems.push('a story has an empty id');
    if (ids.has(id)) problems.push(`duplicate story id ${id}`);
    ids.add(id);
    if (story.acceptanceCriteria.length === 0) {
      problems.push(`${id}: no acceptance criteria`);
    }
    for (const criterion of story.acceptanceCriteria) {
      if (criterion.trim() === '') {
        problems.push(`${id}: empty criterion`);
      } else if (isGenericCriterion(criterion)) {
        problems.push(`${id}: generic criterion "${criterion}"`);
      }
    }
  }
  for (const cmd of draft.verify) {
    if (cmd.trim() === '') problems.push('empty verify command');
  }
  return problems;
};

export const prdFromDraft = (
  draft: PrdDraft,
  base: { project: string; branchName: string; planArtifact?: string },
): Prd => ({
  project: base.project,
  branchName: base.branchName,
  description: draft.description,
  ...(base.planArtifact ? { planArtifact: base.planArtifact } : {}),
  verify: draft.verify.map((cmd) => cmd.trim()),
  userStories: draft.stories.map((story, index) => ({
    id: story.id.trim(),
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria.map((c) => c.trim()),
    criterionAmendments: [],
    priority: index + 1,
    passes: false,
    reviewerVerified: false,
    attempts: 0,
    notes: [],
  })),
});

// ---------------------------------------------------------------------------
// Fail-closed read of a stored prd.json (resume path).

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const normalizeAmendment = (raw: unknown): CriterionAmendment | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const strings = [a.original, a.reason, a.evidence, a.authority, a.timestamp];
  if (
    (a.kind !== 'replaced' && a.kind !== 'superseded') ||
    !strings.every((s) => typeof s === 'string' && s.trim() !== '') ||
    (a.kind === 'replaced' &&
      (typeof a.replacement !== 'string' || a.replacement.trim() === '')) ||
    (a.kind === 'superseded' && a.replacement !== undefined)
  ) {
    return null;
  }
  return {
    kind: a.kind,
    original: a.original as string,
    ...(a.kind === 'replaced' ? { replacement: a.replacement as string } : {}),
    reason: a.reason as string,
    evidence: a.evidence as string,
    authority: a.authority as string,
    timestamp: a.timestamp as string,
  };
};

const normalizeStory = (raw: unknown): Story | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (
    typeof s.id !== 'string' ||
    typeof s.title !== 'string' ||
    typeof s.description !== 'string' ||
    !isStringArray(s.acceptanceCriteria) ||
    typeof s.priority !== 'number' ||
    typeof s.passes !== 'boolean'
  ) {
    return null;
  }
  const rawAmendments = s.criterionAmendments ?? [];
  if (!Array.isArray(rawAmendments)) return null;
  const amendments = rawAmendments.map(normalizeAmendment);
  if (amendments.some((a) => a === null)) return null;
  const ledger = amendments as CriterionAmendment[];
  // invariants: an amended original is no longer active, amended only once
  const originals = new Set<string>();
  for (const a of ledger) {
    if (originals.has(a.original) || s.acceptanceCriteria.includes(a.original))
      return null;
    originals.add(a.original);
  }
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria,
    criterionAmendments: ledger,
    priority: s.priority,
    passes: s.passes,
    reviewerVerified: s.reviewerVerified === true,
    attempts: typeof s.attempts === 'number' ? s.attempts : 0,
    notes: isStringArray(s.notes) ? s.notes : [],
  };
};

export const normalizePrd = (raw: unknown): Prd | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.project !== 'string' ||
    typeof p.branchName !== 'string' ||
    typeof p.description !== 'string' ||
    !Array.isArray(p.userStories)
  ) {
    return null;
  }
  const stories = p.userStories.map(normalizeStory);
  if (stories.some((s) => s === null)) return null;
  return {
    project: p.project,
    branchName: p.branchName,
    description: p.description,
    ...(typeof p.planArtifact === 'string'
      ? { planArtifact: p.planArtifact }
      : {}),
    verify: isStringArray(p.verify) ? p.verify : [],
    userStories: stories as Story[],
  };
};

// ---------------------------------------------------------------------------
// Formatting for prompts and reports (ported from OMC formatStory/formatPrd).

export const formatAmendments = (story: Story): string => {
  if (story.criterionAmendments.length === 0) return '';
  const lines = ['**Amended/Superseded criteria (evidence ledger):**'];
  for (const a of story.criterionAmendments) {
    const action =
      a.kind === 'replaced' ? `replaced by: ${a.replacement}` : 'superseded';
    lines.push(
      `- ~~${a.original}~~ (${action}; reason: ${a.reason}; evidence: ${a.evidence}; authority: ${a.authority}; at: ${a.timestamp})`,
    );
  }
  return lines.join('\n');
};

const storyStatus = (story: Story): string => {
  if (story.passes && story.reviewerVerified) return 'COMPLETE';
  if (story.passes) return 'AWAITING REVIEW';
  return 'PENDING';
};

export const formatStory = (story: Story): string => {
  const lines = [
    `## ${story.id}: ${story.title}`,
    `Status: ${storyStatus(story)}`,
    `Priority: ${story.priority}`,
    `Attempts: ${story.attempts}`,
    '',
    story.description,
    '',
    '**Acceptance criteria:**',
    ...story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
  ];
  const ledger = formatAmendments(story);
  if (ledger) lines.push('', ledger);
  if (story.notes.length > 0) {
    lines.push('', '**Notes:**', ...story.notes.map((n) => `- ${n}`));
  }
  return lines.join('\n');
};

export const formatPrdStatus = (status: PrdStatus): string => {
  const lines = [
    `[PRD status: ${status.passed}/${status.total} stories pass, ${status.verified} reviewer-verified]`,
  ];
  if (status.allPass) lines.push('All stories pass.');
  else {
    lines.push(`Remaining: ${status.pending.map((s) => s.id).join(', ')}`);
    if (status.next)
      lines.push(`Next: ${status.next.id} - ${status.next.title}`);
  }
  return lines.join('\n');
};

export const formatPrd = (prd: Prd): string => {
  const lines = [
    `# ${prd.project}`,
    `Branch: ${prd.branchName}`,
    ...(prd.planArtifact ? [`Plan: ${prd.planArtifact}`] : []),
    '',
    prd.description,
    '',
    formatPrdStatus(prdStatus(prd)),
    '',
    ...(prd.verify.length > 0
      ? ['Verify commands:', ...prd.verify.map((c) => `- \`${c}\``), '']
      : []),
    '---',
    '',
  ];
  for (const story of [...prd.userStories].sort(byPriority)) {
    lines.push(formatStory(story), '', '---', '');
  }
  return lines.join('\n');
};
