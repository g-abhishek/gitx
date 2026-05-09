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
