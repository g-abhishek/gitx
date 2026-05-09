import axios, { type AxiosInstance, isAxiosError } from "axios";
import { withRetry } from "../utils/retry.js";
import { GitxError } from "../utils/errors.js";
import type {
  CreatePrOptions,
  GitProvider,
  PullRequest,
  PullRequestComment,
} from "./base.js";

// ─── Raw GitLab API shapes ────────────────────────────────────────────────────
interface GlMr {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string; // "opened" | "closed" | "merged" | "locked"
  source_branch: string;
  target_branch: string;
  web_url: string;
  author: { username: string } | null;
  created_at: string;
  updated_at: string;
}

interface GlNote {
  id: number;
  body: string;
  author: { username: string };
  created_at: string;
  system: boolean;
}

interface GlProject {
  default_branch: string;
}

// ─── GitLab Provider ──────────────────────────────────────────────────────────
export class GitLabProvider implements GitProvider {
  private readonly http: AxiosInstance;

  constructor(token: string) {
    this.http = axios.create({
      baseURL: "https://gitlab.com/api/v4",
      headers: {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
      },
      timeout: 20_000,
    });
  }

  /** GitLab requires URL-encoded namespace/project slugs */
  private enc(slug: string): string {
    return encodeURIComponent(slug);
  }

  async listPRs(repoSlug: string): Promise<PullRequest[]> {
    try {
      const { data } = await withRetry(() => this.http.get<GlMr[]>(
        `/projects/${this.enc(repoSlug)}/merge_requests`,
        { params: { state: "opened", per_page: 50 } }
      ));
      return data.map(mapGlMr);
    } catch (err) {
      throw wrapGlError(err, "list MRs");
    }
  }

  async getPR(repoSlug: string, prNumber: number): Promise<PullRequest> {
    try {
      const { data } = await this.http.get<GlMr>(
        `/projects/${this.enc(repoSlug)}/merge_requests/${prNumber}`
      );
      return mapGlMr(data);
    } catch (err) {
      throw wrapGlError(err, `get MR !${prNumber}`);
    }
  }

  async createPR(repoSlug: string, opts: CreatePrOptions): Promise<PullRequest> {
    try {
      const { data } = await this.http.post<GlMr>(
        `/projects/${this.enc(repoSlug)}/merge_requests`,
        {
          title: opts.title,
          description: opts.body,
          source_branch: opts.head,
          target_branch: opts.base,
          draft: opts.draft ?? false,
        }
      );
      return mapGlMr(data);
    } catch (err) {
      throw wrapGlError(err, "create MR");
    }
  }

  async getPRComments(repoSlug: string, prNumber: number): Promise<PullRequestComment[]> {
    try {
      const { data } = await this.http.get<GlNote[]>(
        `/projects/${this.enc(repoSlug)}/merge_requests/${prNumber}/notes`,
        { params: { per_page: 100 } }
      );
      return data
        .filter((n) => !n.system)
        .map((n) => ({
          id: n.id,
          body: n.body,
          author: n.author.username,
          createdAt: n.created_at,
        }));
    } catch (err) {
      throw wrapGlError(err, `get MR !${prNumber} notes`);
    }
  }

  async addPRComment(repoSlug: string, prNumber: number, body: string): Promise<void> {
    try {
      await this.http.post(
        `/projects/${this.enc(repoSlug)}/merge_requests/${prNumber}/notes`,
        { body }
      );
    } catch (err) {
      throw wrapGlError(err, `comment on MR !${prNumber}`);
    }
  }


  async getPRDiff(repoSlug: string, prNumber: number): Promise<string> {
    try {
      const { data } = await this.http.get<Array<{ diff: string; new_path: string; old_path: string }>>(
        `/projects/${this.enc(repoSlug)}/merge_requests/${prNumber}/diffs`
      );
      return data.map((d) => `--- a/${d.old_path}\n+++ b/${d.new_path}\n${d.diff}`).join("\n\n");
    } catch {
      return "";
    }
  }

  async closePR(repoSlug: string, prNumber: number): Promise<void> {
    try {
      await this.http.put(
        `/projects/${this.enc(repoSlug)}/merge_requests/${prNumber}`,
        { state_event: "close" }
      );
    } catch (err) {
      throw wrapGlError(err, `close MR !${prNumber}`);
    }
  }

  async getDefaultBranch(repoSlug: string): Promise<string> {
    try {
      const { data } = await withRetry(() =>
        this.http.get<GlProject>(`/projects/${this.enc(repoSlug)}`)
      );
      return data.default_branch ?? "main";
    } catch (err) {
      throw wrapGlError(err, "get default branch");
    }
  }
}

// ─── Mappers ──────────────────────────────────────────────────────────────────
function mapGlMr(d: GlMr): PullRequest {
  let state: "open" | "closed" | "merged";
  if (d.state === "merged") state = "merged";
  else if (d.state === "opened") state = "open";
  else state = "closed";

  return {
    id: d.id,
    number: d.iid,
    title: d.title,
    body: d.description ?? "",
    state,
    head: d.source_branch,
    base: d.target_branch,
    url: d.web_url,
    author: d.author?.username ?? "unknown",
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function wrapGlError(err: unknown, action: string): GitxError {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const msg = (err.response?.data as Record<string, unknown> | undefined)?.message ?? err.message;
    if (status === 401) {
      return new GitxError(
        `GitLab authentication failed while trying to ${action}. Check your token with \`gitx config set-provider gitlab\`.`,
        { exitCode: 1, cause: err }
      );
    }
    if (status === 404) {
      return new GitxError(
        `GitLab resource not found while trying to ${action}. Verify the repo slug and token scopes.`,
        { exitCode: 1, cause: err }
      );
    }
    return new GitxError(
      `GitLab API error (${status ?? "network"}) while trying to ${action}: ${String(msg)}`,
      { exitCode: 1, cause: err }
    );
  }
  return new GitxError(`Unexpected error while trying to ${action}: ${String(err)}`, {
    exitCode: 1,
    cause: err,
  });
}
