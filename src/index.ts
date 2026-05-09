// ─── Core SDK exports ─────────────────────────────────────────────────────────
export { Gitx } from "./core/gitx.js";
export type { GitxPlugin } from "./core/plugin.js";
export type { RepoContext } from "./core/context.js";

// ─── Types ────────────────────────────────────────────────────────────────────
export type { GitxConfig } from "./types/config.js";
export type { AutonomyMode } from "./types/modes.js";
export type { ProviderKind } from "./types/provider.js";

// ─── AI layer ─────────────────────────────────────────────────────────────────
export type { AiClient } from "./ai/types.js";
export type {
  AiAnalyzeTaskResponse,
  AiGeneratePlanResponse,
  AiPlanStep,
  AiGenerateDiffsResponse,
  AiSummarizeChangesResponse,
  AiSuggestFixesResponse,
} from "./ai/types.js";
export { ClaudeAi } from "./ai/claudeAi.js";
export { MockAi } from "./ai/mockAi.js";

// ─── Provider layer ───────────────────────────────────────────────────────────
export type {
  GitProvider,
  PullRequest,
  PullRequestComment,
  CreatePrOptions,
} from "./providers/base.js";
export { GitHubProvider } from "./providers/github.js";
export { GitLabProvider } from "./providers/gitlab.js";
export { AzureProvider } from "./providers/azure.js";
export { createProvider } from "./providers/factory.js";

// ─── Workflows ────────────────────────────────────────────────────────────────
export { runImplementWorkflow } from "./workflows/implement.js";
export type { ImplementOptions, ImplementResult } from "./workflows/implement.js";
export { runReviewWorkflow, runFixCommentsWorkflow } from "./workflows/pr.js";
export type { ReviewResult, FixCommentsResult } from "./workflows/pr.js";

// ─── Utilities ────────────────────────────────────────────────────────────────
export { GitxError } from "./utils/errors.js";
export {
  getGitRemoteOriginUrl,
  isInsideGitRepo,
  inferRepoSlugFromRemote,
  detectProviderFromRemote,
  resolveRepoSlugFromCwd,
} from "./utils/git.js";
