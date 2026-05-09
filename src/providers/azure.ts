import axios, { type AxiosInstance, isAxiosError } from "axios";
import { withRetry } from "../utils/retry.js";
import { GitxError } from "../utils/errors.js";
import type {
  CreatePrOptions,
  GitProvider,
  MergePrOptions,
  PullRequest,
  PullRequestComment,
  SubmitReviewOptions,
} from "./base.js";

/**
 * Azure DevOps slug format expected by this provider: "org/project/repo"
 *
 * Remote URL patterns handled upstream in utils/git.ts:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 */

// ─── Raw Azure DevOps API shapes ──────────────────────────────────────────────
interface AzPr {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string; // "active" | "completed" | "abandoned"
  sourceRefName: string;
  targetRefName: string;
  url: string;
  createdBy: { displayName: string } | null;
  creationDate: string;
  lastMergeSourceCommit?: { author?: { date?: string } };
}

interface AzComment {
  id: number;
  content: string;
  author: { displayName: string };
  publishedDate: string;
  commentType: string; // "text" | "system" | ...
}

interface AzThread {
  comments: AzComment[];
  threadContext?: { filePath?: string; rightFileStart?: { line?: number } };
}

interface AzListResponse<T> {
  value: T[];
}

interface AzRepo {
  defaultBranch?: string;
}

// ─── Azure Provider ───────────────────────────────────────────────────────────
export class AzureProvider implements GitProvider {
  private readonly http: AxiosInstance;
  private readonly org: string;
  private readonly project: string;
  private readonly repoName: string;

  constructor(token: string, repoSlug: string) {
    // Expect "org/project/repo"
    const parts = repoSlug.split("/");
    this.org = parts[0] ?? "unknown";
    this.project = parts[1] ?? "unknown";
    this.repoName = parts[2] ?? parts[1] ?? "unknown";

    // Azure PAT auth: Basic base64(:<token>)
    const encodedToken = Buffer.from(`:${token}`).toString("base64");

    this.http = axios.create({
      baseURL: `https://dev.azure.com/${this.org}/${this.project}/_apis`,
      headers: {
        Authorization: `Basic ${encodedToken}`,
        "Content-Type": "application/json",
      },
      timeout: 20_000,
    });
  }

  private apiParams(extra?: Record<string, string>): Record<string, string> {
    return { "api-version": "7.1-preview.1", ...extra };
  }

  async listPRs(_repoSlug: string): Promise<PullRequest[]> {
    try {
      const { data } = await this.http.get<AzListResponse<AzPr>>(
        `/git/repositories/${this.repoName}/pullrequests`,
        {
          params: this.apiParams({ "searchCriteria.status": "active", $top: "50" }),
        }
      );
      return (data.value ?? []).map(mapAzPr);
    } catch (err) {
      throw wrapAzError(err, "list PRs");
    }
  }

  async getPR(_repoSlug: string, prNumber: number): Promise<PullRequest> {
    try {
      const { data } = await this.http.get<AzPr>(
        `/git/repositories/${this.repoName}/pullrequests/${prNumber}`,
        { params: this.apiParams() }
      );
      return mapAzPr(data);
    } catch (err) {
      throw wrapAzError(err, `get PR #${prNumber}`);
    }
  }

  async createPR(_repoSlug: string, opts: CreatePrOptions): Promise<PullRequest> {
    try {
      const { data } = await this.http.post<AzPr>(
        `/git/repositories/${this.repoName}/pullrequests`,
        {
          title: opts.title,
          description: opts.body,
          sourceRefName: `refs/heads/${opts.head}`,
          targetRefName: `refs/heads/${opts.base}`,
          isDraft: opts.draft ?? false,
        },
        { params: this.apiParams() }
      );
      return mapAzPr(data);
    } catch (err) {
      throw wrapAzError(err, "create PR");
    }
  }

  async getPRComments(_repoSlug: string, prNumber: number): Promise<PullRequestComment[]> {
    try {
      const { data } = await this.http.get<AzListResponse<AzThread>>(
        `/git/repositories/${this.repoName}/pullrequests/${prNumber}/threads`,
        { params: this.apiParams() }
      );
      const result: PullRequestComment[] = [];
      for (const thread of data.value ?? []) {
        for (const c of thread.comments ?? []) {
          if (c.commentType !== "system") {
            result.push({
              id: c.id,
              body: c.content,
              author: c.author?.displayName ?? "unknown",
              path: thread.threadContext?.filePath,
              line: thread.threadContext?.rightFileStart?.line,
              createdAt: c.publishedDate,
            });
          }
        }
      }
      return result;
    } catch (err) {
      throw wrapAzError(err, `get PR #${prNumber} threads`);
    }
  }

  async addPRComment(_repoSlug: string, prNumber: number, body: string): Promise<void> {
    try {
      await this.http.post(
        `/git/repositories/${this.repoName}/pullrequests/${prNumber}/threads`,
        {
          comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
          status: 1,
        },
        { params: this.apiParams() }
      );
    } catch (err) {
      throw wrapAzError(err, `comment on PR #${prNumber}`);
    }
  }


  async getPRDiff(_repoSlug: string, prNumber: number): Promise<string> {
    try {
      // Get latest iteration first
      const iterRes = await this.http.get<{ value: Array<{ id: number }> }>(
        `/git/repositories/${this.repoName}/pullRequests/${prNumber}/iterations`,
        { params: this.apiParams() }
      );
      const iterations = iterRes.data.value ?? [];
      if (iterations.length === 0) return "";
      const latestId = iterations[iterations.length - 1]!.id;

      const { data } = await this.http.get<{ changeEntries: Array<{ item: { path: string }; changeType: number }> }>(
        `/git/repositories/${this.repoName}/pullRequests/${prNumber}/iterations/${latestId}/changes`,
        { params: this.apiParams() }
      );
      const paths = (data.changeEntries ?? []).map((e) => e.item?.path).filter(Boolean);
      return paths.length > 0 ? `Changed files:\n${paths.join("\n")}` : "";
    } catch {
      return "";
    }
  }

  async mergePR(_repoSlug: string, prNumber: number, opts: MergePrOptions): Promise<void> {
    // Azure requires the latest source commit SHA to complete a PR
    let lastMergeSourceCommit: { commitId: string } | undefined;
    try {
      const { data } = await this.http.get<AzPr>(
        `/git/repositories/${this.repoName}/pullrequests/${prNumber}`,
        { params: this.apiParams() }
      );
      // Azure puts the head commit on the PR object
      const pr = data as AzPr & { lastMergeSourceCommit?: { commitId: string } };
      lastMergeSourceCommit = pr.lastMergeSourceCommit;
    } catch (err) {
      throw wrapAzError(err, `get PR #${prNumber} for merge`);
    }

    // Map our method to Azure's mergeStrategy
    const strategyMap: Record<MergePrOptions["method"], string> = {
      squash: "squash",
      merge: "noFastForward",
      rebase: "rebase",
    };

    try {
      await this.http.patch(
        `/git/repositories/${this.repoName}/pullrequests/${prNumber}`,
        {
          status: "completed",
          lastMergeSourceCommit,
          completionOptions: {
            mergeStrategy: strategyMap[opts.method],
            deleteSourceBranch: opts.deleteSourceBranch ?? false,
            squashMerge: opts.method === "squash",
          },
        },
        { params: this.apiParams() }
      );
    } catch (err) {
      throw wrapAzError(err, `merge PR #${prNumber}`);
    }
  }

  async closePR(_repoSlug: string, prNumber: number): Promise<void> {
    try {
      await this.http.patch(
        `/git/repositories/${this.repoName}/pullrequests/${prNumber}`,
        { status: "abandoned" },
        { params: this.apiParams() }
      );
    } catch (err) {
      throw wrapAzError(err, `abandon PR #${prNumber}`);
    }
  }

  async submitPRReview(_repoSlug: string, prNumber: number, opts: SubmitReviewOptions): Promise<void> {
    const verdictPrefix =
      opts.event === "approve" ? "✅ APPROVED" :
      opts.event === "request_changes" ? "🔴 CHANGES REQUESTED" : "💬 REVIEW";

    try {
      // Post the summary as a PR thread
      await this.http.post(
        `/git/repositories/${this.repoName}/pullrequests/${prNumber}/threads`,
        {
          comments: [{ parentCommentId: 0, content: `${verdictPrefix}\n\n${opts.body}`, commentType: 1 }],
          status: 1,
        },
        { params: this.apiParams() }
      );

      // Post inline comments as file-level threads
      for (const c of opts.comments ?? []) {
        await this.http.post(
          `/git/repositories/${this.repoName}/pullrequests/${prNumber}/threads`,
          {
            comments: [{ parentCommentId: 0, content: c.body, commentType: 1 }],
            threadContext: {
              filePath: `/${c.path}`,
              rightFileStart: { line: c.line, offset: 1 },
              rightFileEnd: { line: c.line, offset: 120 },
            },
            status: 1,
          },
          { params: this.apiParams() }
        ).catch(() => {});
      }
    } catch (err) {
      throw wrapAzError(err, `submit review on PR #${prNumber}`);
    }
  }

  async replyToComment(_repoSlug: string, prNumber: number, commentId: number, body: string): Promise<void> {
    try {
      // Azure DevOps: add a comment to an existing thread
      // We don't have the threadId stored separately, so post a new general comment
      const replyBody = `*(in reply to comment #${commentId})*\n\n${body}`;
      await this.http.post(
        `/git/repositories/${this.repoName}/pullRequests/${prNumber}/threads`,
        {
          comments: [{ parentCommentId: 0, content: replyBody, commentType: 1 }],
          status: 4, // Fixed
        },
        { params: this.apiParams() }
      );
    } catch (err) {
      throw wrapAzError(err, `reply to comment #${commentId}`);
    }
  }

  async getDefaultBranch(_repoSlug: string): Promise<string> {
    try {
      const { data } = await this.http.get<AzRepo>(
        `/git/repositories/${this.repoName}`,
        { params: this.apiParams() }
      );
      return (data.defaultBranch ?? "refs/heads/main").replace("refs/heads/", "");
    } catch (err) {
      throw wrapAzError(err, "get default branch");
    }
  }
}

// ─── Mappers ──────────────────────────────────────────────────────────────────
function mapAzPr(d: AzPr): PullRequest {
  let state: "open" | "closed" | "merged";
  if (d.status === "completed") state = "merged";
  else if (d.status === "active") state = "open";
  else state = "closed";

  return {
    id: d.pullRequestId,
    number: d.pullRequestId,
    title: d.title,
    body: d.description ?? "",
    state,
    head: (d.sourceRefName ?? "").replace("refs/heads/", ""),
    base: (d.targetRefName ?? "").replace("refs/heads/", ""),
    url: d.url ?? "",
    author: d.createdBy?.displayName ?? "unknown",
    createdAt: d.creationDate ?? "",
    updatedAt: d.lastMergeSourceCommit?.author?.date ?? d.creationDate ?? "",
  };
}

function wrapAzError(err: unknown, action: string): GitxError {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const msg = (err.response?.data as Record<string, string> | undefined)?.message ?? err.message;
    if (status === 401 || status === 203) {
      return new GitxError(
        `Azure DevOps authentication failed while trying to ${action}. Check your PAT token with \`gitx config set-provider azure\`.`,
        { exitCode: 1, cause: err }
      );
    }
    if (status === 404) {
      return new GitxError(
        `Azure DevOps resource not found while trying to ${action}. Verify org/project/repo slug and token scopes.`,
        { exitCode: 1, cause: err }
      );
    }
    return new GitxError(
      `Azure DevOps API error (${status ?? "network"}) while trying to ${action}: ${msg}`,
      { exitCode: 1, cause: err }
    );
  }
  return new GitxError(`Unexpected error while trying to ${action}: ${String(err)}`, {
    exitCode: 1,
    cause: err,
  });
}
