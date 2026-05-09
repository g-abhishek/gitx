export interface AiAnalyzeTaskResponse {
  task: string;
  intent: "refactor" | "bugfix" | "feature" | "chore" | "unknown";
  summary: string;
  assumptions: string[];
  risks: string[];
}

export interface AiPlanStep {
  id: string;
  title: string;
  description: string;
}

export interface AiGeneratePlanResponse {
  steps: AiPlanStep[];
}

export interface AiGenerateDiffsResponse {
  stepId: string;
  diffs: Array<{ path: string; unifiedDiff: string }>;
}

export interface AiSummarizeChangesResponse {
  summary: string;
  filesChanged: Array<{ path: string; changeType: "add" | "modify" | "delete" }>;
}

export interface AiSuggestFixesResponse {
  suggestedEdits: Array<{ path: string; rationale: string; unifiedDiff: string }>;
}

export interface AiCommitMessageResponse {
  /** Full conventional commit subject line, e.g. "feat(auth): add OAuth2 login flow" */
  subject: string;
  /** Optional multi-line body explaining WHY the change was made */
  body?: string;
}

export interface AiPrContentResponse {
  /** Short, human-readable PR title (not necessarily conventional-commit format) */
  title: string;
  /** Multi-paragraph PR description: what changed, why, how to test */
  body: string;
}

export interface AiConflictResolutionResponse {
  /** The full file content with ALL conflict markers removed and conflicts resolved. */
  resolved: string;
  /**
   * "high"  → AI is confident both sides are fully reconciled — safe to auto-apply.
   * "low"   → Changes are contradictory or ambiguous — show to user for confirmation.
   */
  confidence: "high" | "low";
  /** One-sentence explanation of what the AI did (shown to the user). */
  explanation: string;
}

export interface AiClient {
  analyzeTask(input: string): Promise<AiAnalyzeTaskResponse>;
  generatePlan(context: unknown): Promise<AiGeneratePlanResponse>;
  generateDiffs(step: unknown): Promise<AiGenerateDiffsResponse>;
  summarizeChanges(diff: unknown): Promise<AiSummarizeChangesResponse>;
  suggestFixes(comment: unknown): Promise<AiSuggestFixesResponse>;
  reviewPR(context: unknown): Promise<AiReviewPRResponse>;
  /** Generate a conventional commit message from a unified diff. */
  generateCommitMessage(diff: string): Promise<AiCommitMessageResponse>;
  /** Generate a PR title and description from branch commits + diff. */
  generatePrContent(commits: string[], diff: string): Promise<AiPrContentResponse>;
  /**
   * Resolve git merge conflict markers in a file.
   * Returns the fully resolved file content + confidence level.
   */
  resolveConflict(filePath: string, conflictContent: string): Promise<AiConflictResolutionResponse>;

  /**
   * Senior-developer quality PR review with full codebase context.
   * Returns inline comments, checklist, and a formal verdict.
   */
  reviewPRDetailed(context: {
    /** PR title */
    prTitle: string;
    /** PR description */
    prBody: string;
    /** Author of the PR */
    author: string;
    /** Source branch name */
    headBranch: string;
    /** Target branch name */
    baseBranch: string;
    /** Full unified diff of the PR (may be truncated) */
    diff: string;
    /** Files changed — key: relative path, value: FULL file content after changes */
    changedFiles: Record<string, string>;
    /** Supporting context files the changes depend on */
    contextFiles: Record<string, string>;
    /** Flat list of all repo files (for structural awareness) */
    repoFileList: string[];
    /** Existing PR comments */
    existingComments: Array<{ author: string; body: string; path?: string; line?: number }>;
  }): Promise<AiDetailedReviewResponse>;
}

export interface AiReviewPRResponse {
  summary: string;
  issues: Array<{
    severity: "critical" | "warning" | "suggestion";
    description: string;
    file?: string;
    line?: number;
  }>;
  positives: string[];
  verdict: "approve" | "request_changes" | "comment";
}

/** Inline comment on a specific file + line produced by the senior-dev review. */
export interface AiInlineComment {
  /** Relative path to the file being commented on */
  path: string;
  /** The line number in the NEW (right) version of the file */
  line: number;
  /** The comment body (markdown supported) */
  body: string;
  /** Severity for local display */
  severity: "critical" | "warning" | "suggestion";
  /** Optional drop-in code suggestion (replaces the commented line) */
  suggestion?: string;
}

/**
 * Rich structured review response from the senior-dev AI reviewer.
 * Supersedes the basic AiReviewPRResponse for the `gitx pr review` command.
 */
export interface AiDetailedReviewResponse {
  /** 3-5 sentence executive summary of the PR */
  summary: string;
  /** Verdict to submit to the hosting platform */
  verdict: "approve" | "request_changes" | "comment";
  /** High-level issues not tied to a specific line */
  issues: Array<{
    severity: "critical" | "warning" | "suggestion";
    description: string;
    file?: string;
    line?: number;
  }>;
  /** Specific inline comments on changed lines */
  inlineComments: AiInlineComment[];
  /** Things done well in this PR */
  positives: string[];
  /** How to manually test the changes */
  testingNotes: string;
  /** Which review dimensions were checked */
  checklist: Array<{
    area: string;   // e.g. "Security", "Performance", "Error handling"
    status: "pass" | "warn" | "fail";
    note: string;
  }>;
}
