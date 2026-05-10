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

/**
 * AI-generated fix for a single PR review comment.
 * Targets a specific line range in a file with a minimal replacement.
 */
export interface AiFixResponse {
  /** Relative path to the file that needs to change */
  file: string;
  /** 1-based line number where the replacement starts */
  startLine: number;
  /** 1-based line number where the replacement ends (inclusive) */
  endLine: number;
  /**
   * The new code to replace lines startLine–endLine with.
   * Must preserve surrounding indentation style.
   */
  replacement: string;
  /** One-sentence explanation shown to the user */
  explanation: string;
  /**
   * "high" → safe to auto-apply without confirmation.
   * "low"  → show diff and ask user before applying.
   */
  confidence: "high" | "low";
  /** Does this fix fully resolve the comment (vs partially)? */
  resolves: boolean;
  /**
   * true when the comment is a question / discussion with no code change needed.
   * In this case startLine/endLine/replacement are empty and should be ignored.
   */
  isDiscussion: boolean;
}

// ─── Ask command types ────────────────────────────────────────────────────────

/**
 * Diagnostic snapshot of which AI provider is active and how it was resolved.
 * Keys are never included — only whether they are present.
 */
export interface AiSetupStatus {
  /**
   * Human-readable provider name, e.g. "claude (Anthropic API)", "openai", "claude-cli (local)", "none".
   * "none" means no provider is configured and MockAi will be used.
   */
  provider: string;
  /** Model in use, if applicable (e.g. "claude-3-5-haiku-20241022", "gpt-4o") */
  model?: string;
  /**
   * Where the key / credential came from:
   * "ANTHROPIC_API_KEY env var" | "OPENAI_API_KEY env var" | "config file" | "local CLI" | "none"
   */
  keySource: string;
  /** true when at least one real AI provider is available */
  isConfigured: boolean;
}

/**
 * Status of a single configured git hosting provider.
 * The actual token value is never included.
 */
export interface GitProviderStatus {
  /** "github" | "gitlab" | "azure" */
  name: string;
  /** true when a non-empty token exists for this provider */
  hasToken: boolean;
}

/**
 * Live repo context gathered by `gitx ask` and injected into the AI prompt.
 * All fields are optional so partial context still produces useful answers.
 */
export interface AiAskContext {
  /** Whether the CWD is inside a git repository */
  isInsideGitRepo: boolean;
  /** Current checked-out branch name (only meaningful when isInsideGitRepo is true) */
  currentBranch: string;
  /** Last 10 commits as one-line summaries (hash + subject) */
  recentCommits: string[];
  /** Output of `git status --short` */
  gitStatus: string;
  /** Open pull requests from the remote provider */
  openPRs?: Array<{ number: number; title: string; state: string; branch: string }>;
  /** Stash entries (e.g. "stash@{0}: WIP on feat/x: abc1234 msg") */
  stashes?: string[];
  /** Detailed status of the active AI provider */
  aiSetup: AiSetupStatus;
  /** All configured git hosting providers (github / gitlab / azure) */
  gitProviders: GitProviderStatus[];
  /** The configured default base branch, if any */
  defaultBranch?: string;
}

/** Response returned by `AiClient.ask()` for the `gitx ask` command. */
export interface AiAskResponse {
  /** Full answer in plain text or markdown */
  answer: string;
  /**
   * Concrete gitx (or git) commands the user can run to act on the answer.
   * Omit when not applicable.
   */
  suggestedCommands?: string[];
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
  /**
   * Generate a PR title and description from branch commits + diff.
   * Pass `stat` (output of `git diff --stat`) alongside the diff so the AI
   * sees every changed file even when the detailed patch is truncated.
   */
  generatePrContent(commits: string[], diff: string, stat?: string): Promise<AiPrContentResponse>;
  /**
   * Resolve git merge conflict markers in a file.
   * Returns the fully resolved file content + confidence level.
   */
  resolveConflict(filePath: string, conflictContent: string): Promise<AiConflictResolutionResponse>;

  /**
   * Generate a targeted fix for a single PR review comment.
   * Returns a line-range replacement (startLine–endLine → replacement).
   */
  generateFix(context: {
    /** The review comment text to address */
    comment: string;
    /** Author of the comment */
    commentAuthor: string;
    /** Relative file path the comment is on */
    filePath: string;
    /** 1-based line number the comment targets */
    line: number;
    /** Full current file content (after PR changes) */
    fileContent: string;
    /** The relevant diff section for this file */
    fileDiff: string;
  }): Promise<AiFixResponse>;

  /**
   * Answer a free-form question about the repo using live git context + AI.
   * Used by `gitx ask "<question>"`.
   *
   * @param question  The raw question string from the user.
   * @param context   Live repo state gathered by the ask command.
   */
  ask(question: string, context: AiAskContext): Promise<AiAskResponse>;

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
