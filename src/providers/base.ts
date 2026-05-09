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
}
