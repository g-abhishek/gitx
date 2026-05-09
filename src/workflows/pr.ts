/**
 * PR Workflow helpers
 *
 * Shared logic used by the `pr review` and `pr fix-comments` CLI commands.
 */

import type { Gitx } from "../core/gitx.js";
import type { PullRequest, PullRequestComment } from "../providers/base.js";
import { createProvider } from "../providers/factory.js";
import { readRepoFile, listTrackedFiles } from "../utils/gitOps.js";
import { logger } from "../logger/logger.js";

// ─── Review workflow ──────────────────────────────────────────────────────────

export interface ReviewResult {
  pr: PullRequest;
  comments: PullRequestComment[];
  aiSummary: string;
}

/**
 * Fetch a PR and its comments, generate an AI-powered review summary,
 * then post the summary back as a PR comment.
 */
export async function runReviewWorkflow(
  gitx: Gitx,
  prNumber: number,
  postComment = true
): Promise<ReviewResult> {
  const ctx = await gitx.getRepoContext();
  const provider = createProvider(ctx);

  logger.info(`🔍 Fetching PR #${prNumber}…`);
  const pr = await provider.getPR(ctx.repoSlug, prNumber);

  logger.info("💬 Fetching comments…");
  const comments = await provider.getPRComments(ctx.repoSlug, prNumber);

  logger.info("🧠 Generating AI review…");
  const commentContext = {
    prTitle: pr.title,
    prBody: pr.body,
    comments: comments.map((c) => ({
      body: c.body,
      author: c.author,
      path: c.path,
      line: c.line,
    })),
  };

  // Use summarize as a proxy for review (we ask it to evaluate comments)
  const summaryResult = await gitx.ai.summarizeChanges({
    rawDiff: `PR: ${pr.title}\n\nDescription:\n${pr.body}\n\nExisting comments:\n${comments.map((c) => `[${c.author}]: ${c.body}`).join("\n")}`,
    reviewMode: true,
    commentContext,
  });

  const aiSummary = summaryResult.summary;

  if (postComment && aiSummary) {
    logger.info("📝 Posting AI review comment…");
    const commentBody = `## 🤖 AI Review (gitx)\n\n${aiSummary}`;
    await provider.addPRComment(ctx.repoSlug, prNumber, commentBody);
    logger.success("Review comment posted.");
  }

  return { pr, comments, aiSummary };
}

// ─── Fix-comments workflow ────────────────────────────────────────────────────

export interface FixCommentsResult {
  pr: PullRequest;
  comments: PullRequestComment[];
  appliedFixes: Array<{ path: string; rationale: string }>;
  skippedFixes: Array<{ path: string; reason: string }>;
}

/**
 * Fetch PR review comments, ask AI to suggest fixes, apply them, and
 * commit + push the changes.
 */
export async function runFixCommentsWorkflow(
  gitx: Gitx,
  prNumber: number,
  dryRun = false
): Promise<FixCommentsResult> {
  const { applyUnifiedDiff, stageAll, hasStagedChanges, commitChanges } = await import(
    "../utils/gitOps.js"
  );
  const cwd = gitx.cwd;
  const ctx = await gitx.getRepoContext();
  const provider = createProvider(ctx);

  logger.info(`🔍 Fetching PR #${prNumber}…`);
  const pr = await provider.getPR(ctx.repoSlug, prNumber);

  logger.info("💬 Fetching review comments…");
  const comments = await provider.getPRComments(ctx.repoSlug, prNumber);

  if (comments.length === 0) {
    logger.info("No review comments found.");
    return { pr, comments, appliedFixes: [], skippedFixes: [] };
  }

  // Gather file contents for files mentioned in comments
  const mentionedPaths = [...new Set(comments.map((c) => c.path).filter(Boolean) as string[])];
  const trackedFiles = await listTrackedFiles(cwd);

  // Also include files mentioned in the PR body / title
  const allSourceFiles = trackedFiles
    .filter((f) => /\.(ts|js|tsx|jsx|py|go|rs|java|rb|cs|cpp|c|h)$/.test(f))
    .slice(0, 15);

  const relevantFiles = [...new Set([...mentionedPaths, ...allSourceFiles])].slice(0, 15);
  const fileContents: Record<string, string> = {};
  for (const f of relevantFiles) {
    const content = await readRepoFile(f, cwd);
    if (content) fileContents[f] = content.slice(0, 4000);
  }

  logger.info("🧠 Generating AI-suggested fixes…");
  const fixResult = await gitx.ai.suggestFixes({
    comments: comments.map((c) => ({
      body: c.body,
      author: c.author,
      path: c.path,
      line: c.line,
    })),
    prTitle: pr.title,
    prBody: pr.body,
    fileContents,
  });

  const appliedFixes: Array<{ path: string; rationale: string }> = [];
  const skippedFixes: Array<{ path: string; reason: string }> = [];

  for (const edit of fixResult.suggestedEdits) {
    if (dryRun) {
      logger.info(`  ↳ [dry-run] Would apply fix to: ${edit.path}`);
      logger.info(`     Rationale: ${edit.rationale}`);
      appliedFixes.push({ path: edit.path, rationale: edit.rationale });
      continue;
    }

    const applyResult = await applyUnifiedDiff(edit.unifiedDiff, cwd);
    if (applyResult.ok) {
      logger.info(`  ↳ Applied fix to: ${edit.path}`);
      appliedFixes.push({ path: edit.path, rationale: edit.rationale });
    } else {
      logger.warn(`  ↳ Could not apply fix to ${edit.path}: ${applyResult.error ?? "unknown"}`);
      skippedFixes.push({
        path: edit.path,
        reason: applyResult.error ?? "git apply failed",
      });
    }
  }

  if (!dryRun && appliedFixes.length > 0) {
    await stageAll(cwd);
    if (await hasStagedChanges(cwd)) {
      const msg = `fix: address PR #${prNumber} review comments\n\n${appliedFixes.map((f) => `- ${f.path}: ${f.rationale}`).join("\n")}`;
      const sha = await commitChanges(msg, cwd);
      logger.success(`Committed fixes: ${sha.slice(0, 8)}`);

      // Post summary comment
      const fixSummary = appliedFixes.map((f) => `- \`${f.path}\`: ${f.rationale}`).join("\n");
      await provider.addPRComment(
        ctx.repoSlug,
        prNumber,
        `## 🤖 Auto-fixes applied (gitx)\n\n${fixSummary}\n\nCommit: \`${sha.slice(0, 8)}\``
      );
    }
  }

  return { pr, comments, appliedFixes, skippedFixes };
}
