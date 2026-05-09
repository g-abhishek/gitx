import axios, { type AxiosInstance, isAxiosError } from "axios";
import { withRetry } from "../utils/retry.js";
import { GitxError } from "../utils/errors.js";
import type {
  CreatePrOptions,
  GitProvider,
  MergePrOptions,
  PullRequest,
  PullRequestComment,
  ReviewComment,
  SubmitReviewOptions,
} from "./base.js";

// ─── Raw GitHub API shapes ────────────────────────────────────────────────────
interface GhPr {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  head: { ref: string };
  base: { ref: string };
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

interface GhComment {
  id: number;
  body: string;
  user: { login: string } | null;
  path?: string;
  line?: number;
  created_at: string;
}

interface GhRepo {
  default_branch: string;
}

// ─── GitHub Provider ──────────────────────────────────────────────────────────
export class GitHubProvider implements GitProvider {
  private readonly http: AxiosInstance;

  constructor(token: string) {
    this.http = axios.create({
      baseURL: "https://api.github.com",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeout: 20_000,
    });
  }

  async listPRs(repoSlug: string): Promise<PullRequest[]> {
    try {
      const { data } = await withRetry(() => this.http.get<GhPr[]>(`/repos/${repoSlug}/pulls`, {
        params: { state: "open", per_page: 50 },
      }));
      return data.map(mapGhPr);
    } catch (err) {
      throw wrapGhError(err, "list PRs");
    }
  }

  async getPR(repoSlug: string, prNumber: number): Promise<PullRequest> {
    try {
      const { data } = await withRetry(() => this.http.get<GhPr>(`/repos/${repoSlug}/pulls/${prNumber}`));
      return mapGhPr(data);
    } catch (err) {
      throw wrapGhError(err, `get PR #${prNumber}`);
    }
  }

  async createPR(repoSlug: string, opts: CreatePrOptions): Promise<PullRequest> {
    try {
      const { data } = await this.http.post<GhPr>(`/repos/${repoSlug}/pulls`, {
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
        draft: opts.draft ?? false,
      });
      return mapGhPr(data);
    } catch (err) {
      throw wrapGhError(err, "create PR");
    }
  }

  async getPRComments(repoSlug: string, prNumber: number): Promise<PullRequestComment[]> {
    try {
      // Fetch both review comments (on code) and issue comments (general)
      const [reviewRes, issueRes] = await Promise.all([
        this.http.get<GhComment[]>(`/repos/${repoSlug}/pulls/${prNumber}/comments`, {
          params: { per_page: 100 },
        }),
        this.http.get<GhComment[]>(`/repos/${repoSlug}/issues/${prNumber}/comments`, {
          params: { per_page: 100 },
        }),
      ]);

      // Map review comments normally (they already carry path + line)
      const reviewComments = reviewRes.data.map(mapGhComment);

      // For issue comments, reconstruct path + line from gitx's fallback format:
      //   📍 **`path/to/file.ts:42`**\n\nactual comment body
      // These are posted when GitHub rejects inline review comments with 422.
      const issueComments = issueRes.data.map((c) => {
        const mapped = mapGhComment(c);
        if (!mapped.path) {
          const m = c.body.match(/^📍 \*\*`([^:`]+):(\d+)`\*\*\n\n([\s\S]+)$/);
          if (m) {
            mapped.path = m[1]!;
            mapped.line = parseInt(m[2]!, 10);
            // Expose the real comment body (without the 📍 header) so the AI
            // gets clean text to work with, not the path:line decoration.
            mapped.body = m[3]!.trim();
          }
        }
        return mapped;
      });

      return [...reviewComments, ...issueComments];
    } catch (err) {
      throw wrapGhError(err, `get PR #${prNumber} comments`);
    }
  }

  async addPRComment(repoSlug: string, prNumber: number, body: string): Promise<void> {
    try {
      await this.http.post(`/repos/${repoSlug}/issues/${prNumber}/comments`, { body });
    } catch (err) {
      throw wrapGhError(err, `comment on PR #${prNumber}`);
    }
  }

  /** Find an existing open PR for head→base, returns undefined if none. */
  async findExistingPR(
    repoSlug: string,
    head: string,
    base: string
  ): Promise<PullRequest | undefined> {
    try {
      const { data } = await withRetry(() =>
        this.http.get<GhPr[]>(`/repos/${repoSlug}/pulls`, {
          params: { state: "open", head: `${repoSlug.split("/")[0]}:${head}`, base, per_page: 5 },
        })
      );
      return data.length > 0 ? mapGhPr(data[0]!) : undefined;
    } catch {
      return undefined;
    }
  }


  async getPRDiff(repoSlug: string, prNumber: number): Promise<string> {
    try {
      const { data } = await withRetry(() =>
        this.http.get<string>(`/repos/${repoSlug}/pulls/${prNumber}`, {
          headers: { Accept: "application/vnd.github.diff" },
          responseType: "text",
        })
      );
      return typeof data === "string" ? data : "";
    } catch (err) {
      // Non-fatal — review can proceed without diff
      return "";
    }
  }

  async mergePR(repoSlug: string, prNumber: number, opts: MergePrOptions): Promise<void> {
    try {
      await this.http.put(`/repos/${repoSlug}/pulls/${prNumber}/merge`, {
        merge_method: opts.method,                    // "squash" | "merge" | "rebase"
        commit_title: opts.commitTitle,
        commit_message: opts.commitMessage ?? "",
      });
    } catch (err) {
      throw wrapGhError(err, `merge PR #${prNumber}`);
    }
  }

  async closePR(repoSlug: string, prNumber: number): Promise<void> {
    try {
      await this.http.patch(`/repos/${repoSlug}/pulls/${prNumber}`, { state: "closed" });
    } catch (err) {
      throw wrapGhError(err, `close PR #${prNumber}`);
    }
  }

  async submitPRReview(repoSlug: string, prNumber: number, opts: SubmitReviewOptions): Promise<void> {
    const eventMap: Record<SubmitReviewOptions["event"], string> = {
      approve: "APPROVE",
      request_changes: "REQUEST_CHANGES",
      comment: "COMMENT",
    };

    const ghComments = (opts.comments ?? [])
      .filter((c) => c.line > 0)
      .map((c: ReviewComment) => ({
        path: c.path,
        line: c.line,
        side: "RIGHT" as const,
        body: c.body,
      }));

    // ── Attempt 1: formal review with all inline comments ─────────────────
    // GitHub only accepts inline comments on lines that actually appear in
    // the diff (changed lines + context lines within hunks). If any comment
    // references a line outside the diff, GitHub rejects the entire request
    // with 422 "Line could not be resolved".
    if (ghComments.length > 0) {
      try {
        await this.http.post(`/repos/${repoSlug}/pulls/${prNumber}/reviews`, {
          body: opts.body,
          event: eventMap[opts.event],
          comments: ghComments,
        });
        return; // success — all inline comments accepted
      } catch (err) {
        if (!isAxiosError(err) || err.response?.status !== 422) {
          throw wrapGhError(err, `submit review on PR #${prNumber}`);
        }
        // 422 → some inline comments are on lines outside the diff.
        // Fall through to attempt 2.
      }
    }

    // ── Attempt 2: formal review without inline comments ──────────────────
    // Posts the verdict (APPROVE / REQUEST_CHANGES / COMMENT) and summary
    // body as a proper review, then posts each inline comment as a separate
    // plain PR comment so the text is never lost.
    try {
      await this.http.post(`/repos/${repoSlug}/pulls/${prNumber}/reviews`, {
        body: opts.body,
        event: eventMap[opts.event],
        // Omit `comments` entirely — avoid sending an empty array which
        // can also trigger a 422 on some GitHub versions.
      });
    } catch {
      // ── Attempt 3: plain issue comment (last resort) ───────────────────
      // If even a comment-free review fails (permissions, draft PR, etc.),
      // fall back to a regular PR comment so the review text still lands.
      await this.http.post(`/repos/${repoSlug}/issues/${prNumber}/comments`, {
        body: opts.body,
      }).catch((e: unknown) => {
        throw wrapGhError(e, `submit review on PR #${prNumber}`);
      });
    }

    // Post each inline comment as a plain PR comment with file:line prefix
    for (const c of ghComments) {
      const body = `📍 **\`${c.path}:${c.line}\`**\n\n${c.body}`;
      await this.http.post(`/repos/${repoSlug}/issues/${prNumber}/comments`, { body })
        .catch(() => {}); // best-effort — don't abort if one comment fails
    }
  }

  async replyToComment(repoSlug: string, prNumber: number, commentId: number, body: string): Promise<void> {
    try {
      // GitHub REST: reply directly to a pull request review comment thread
      await this.http.post(
        `/repos/${repoSlug}/pulls/${prNumber}/comments/${commentId}/replies`,
        { body }
      );
    } catch {
      // Fallback: post as a plain issue comment if the thread reply fails
      await this.http.post(`/repos/${repoSlug}/issues/${prNumber}/comments`, { body })
        .catch((e: unknown) => { throw wrapGhError(e, `reply to comment #${commentId}`); });
    }
  }

  async getDefaultBranch(repoSlug: string): Promise<string> {
    try {
      const { data } = await withRetry(() => this.http.get<GhRepo>(`/repos/${repoSlug}`));
      return data.default_branch ?? "main";
    } catch (err) {
      throw wrapGhError(err, "get default branch");
    }
  }
}

// ─── Mappers ──────────────────────────────────────────────────────────────────
function mapGhPr(d: GhPr): PullRequest {
  return {
    id: d.id,
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    state: d.merged_at ? "merged" : (d.state === "open" ? "open" : "closed"),
    head: d.head.ref,
    base: d.base.ref,
    url: d.html_url,
    author: d.user?.login ?? "unknown",
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function mapGhComment(c: GhComment): PullRequestComment {
  return {
    id: c.id,
    body: c.body,
    author: c.user?.login ?? "unknown",
    path: c.path,
    line: c.line,
    createdAt: c.created_at,
  };
}

function wrapGhError(err: unknown, action: string): GitxError {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as Record<string, unknown> | undefined;
    const msg = (data?.message as string | undefined) ?? err.message;
    // Extract detailed validation errors from GitHub's response body
    const errors = Array.isArray(data?.errors)
      ? (data.errors as Array<Record<string, string>>)
          .map((e) => e.message ?? e.code ?? JSON.stringify(e))
          .filter(Boolean)
          .join("; ")
      : undefined;
    const detail = errors ? `${msg} — ${errors}` : msg;

    if (status === 401 || status === 403) {
      return new GitxError(
        `GitHub authentication failed while trying to ${action}. Check your token with \`gitx config set-provider github\`.`,
        { exitCode: 1, cause: err }
      );
    }
    if (status === 404) {
      return new GitxError(
        `GitHub resource not found while trying to ${action}. Verify the repo slug and that your token has the right scopes.`,
        { exitCode: 1, cause: err }
      );
    }
    if (status === 422) {
      return new GitxError(
        `GitHub rejected the request while trying to ${action}: ${detail}\n` +
        `  Common causes:\n` +
        `    • Head branch not pushed to remote yet → run: git push -u origin HEAD\n` +
        `    • A PR for this branch already exists\n` +
        `    • No commits between head and base branch`,
        { exitCode: 1, cause: err }
      );
    }
    return new GitxError(`GitHub API error (${status ?? "network"}) while trying to ${action}: ${detail}`, {
      exitCode: 1,
      cause: err,
    });
  }
  return new GitxError(`Unexpected error while trying to ${action}: ${String(err)}`, {
    exitCode: 1,
    cause: err,
  });
}
