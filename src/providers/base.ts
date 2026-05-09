// ─── Provider abstraction ────────────────────────────────────────────────────
// Every git-hosting provider (GitHub, GitLab, Azure DevOps) implements this
// interface so the rest of the codebase can remain provider-agnostic.

export interface PullRequest {
  id: number;
  /** Human-facing PR / MR number (used in URLs) */
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  /** Source branch */
  head: string;
  /** Target / base branch */
  base: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestComment {
  id: number;
  body: string;
  author: string;
  /** File path if the comment is on a specific file */
  path?: string;
  /** Line number if the comment is on a specific line */
  line?: number;
  createdAt: string;
}

export interface CreatePrOptions {
  title: string;
  body: string;
  /** Source branch name */
  head: string;
  /** Target branch name */
  base: string;
  draft?: boolean;
}

/** A single inline review comment tied to a specific file + line. */
export interface ReviewComment {
  /** Relative file path */
  path: string;
  /** Line number in the NEW version of the file (right side) */
  line: number;
  /** Markdown comment body */
  body: string;
}

/** Options for submitting a formal PR review (with optional inline comments). */
export interface SubmitReviewOptions {
  /** Overall review body (markdown) */
  body: string;
  /** Review verdict */
  event: "approve" | "request_changes" | "comment";
  /** Inline file+line comments to post */
  comments?: ReviewComment[];
}

export interface MergePrOptions {
  /** How to merge. Providers map this to their own enum. Default: "squash" */
  method: "squash" | "merge" | "rebase";
  /** Optional merge/squash commit title (falls back to PR title) */
  commitTitle?: string;
  /** Optional merge/squash commit message body */
  commitMessage?: string;
  /** Delete the source branch after a successful merge */
  deleteSourceBranch?: boolean;
}

export interface GitProvider {
  /** List open pull requests for the repo */
  listPRs(repoSlug: string): Promise<PullRequest[]>;

  /** Get a single pull request by its number */
  getPR(repoSlug: string, prNumber: number): Promise<PullRequest>;

  /** Create a new pull request */
  createPR(repoSlug: string, opts: CreatePrOptions): Promise<PullRequest>;

  /** Get review comments on a pull request */
  getPRComments(repoSlug: string, prNumber: number): Promise<PullRequestComment[]>;

  /** Post a comment on a pull request */
  addPRComment(repoSlug: string, prNumber: number, body: string): Promise<void>;

  /** Resolve the repo's default branch (e.g. "main", "master") */
  getDefaultBranch(repoSlug: string): Promise<string>;

  /** Get the unified diff of a pull request (all file changes) */
  getPRDiff(repoSlug: string, prNumber: number): Promise<string>;

  /**
   * Close (or abandon on Azure) a pull request.
   * GitHub/GitLab → closed; Azure DevOps → abandoned.
   * PRs cannot be hard-deleted via any provider's public API.
   */
  closePR(repoSlug: string, prNumber: number): Promise<void>;

  /** Merge a pull request using the specified strategy. */
  mergePR(repoSlug: string, prNumber: number, opts: MergePrOptions): Promise<void>;

  /**
   * Submit a formal review (approve / request_changes / comment) with optional
   * inline file-level comments. Falls back to a plain comment if the provider
   * does not support formal reviews.
   */
  submitPRReview(repoSlug: string, prNumber: number, opts: SubmitReviewOptions): Promise<void>;

  /**
   * Reply to a specific review comment thread (to mark it as addressed).
   * Falls back to a general PR comment if thread replies aren't supported.
   */
  replyToComment(repoSlug: string, prNumber: number, commentId: number, body: string): Promise<void>;
}
