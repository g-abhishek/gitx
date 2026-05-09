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
  review?: import("../ai/types.js").AiDetailedReviewResponse;
}

/**
 * Parse a unified diff and return the set of changed file paths.
 */
function parseChangedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    // Match "+++ b/src/foo.ts" lines
    const m = line.match(/^\+\+\+ b\/(.+)/);
    if (m?.[1] && m[1] !== "/dev/null") {
      paths.add(m[1].trim());
    }
  }
  return [...paths];
}

/**
 * Given a list of changed file paths, find supporting context files that are
 * closely related (imported by or importing changed files).
 * Returns at most `maxFiles` file paths.
 */
async function findContextFiles(
  changedPaths: string[],
  allTrackedFiles: string[],
  cwd: string,
  maxFiles = 8
): Promise<string[]> {
  const contextPaths = new Set<string>();

  for (const changedPath of changedPaths.slice(0, 10)) {
    const content = await readRepoFile(changedPath, cwd);
    if (!content) continue;

    // Extract relative import paths from TypeScript/JS files
    const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
    for (const [, importPath] of importMatches) {
      if (!importPath || importPath.startsWith("node:") || !importPath.startsWith(".")) continue;
      // Resolve the import path relative to the file's directory
      const dir = changedPath.split("/").slice(0, -1).join("/");
      const candidates = [
        `${dir}/${importPath}.ts`,
        `${dir}/${importPath}.tsx`,
        `${dir}/${importPath}/index.ts`,
        `${dir}/${importPath}`,
      ].map((p) => p.replace(/\/\//g, "/").replace(/^\//, ""));

      for (const candidate of candidates) {
        if (allTrackedFiles.includes(candidate) && !changedPaths.includes(candidate)) {
          contextPaths.add(candidate);
          break;
        }
      }
    }

    if (contextPaths.size >= maxFiles) break;
  }

  return [...contextPaths].slice(0, maxFiles);
}

/**
 * Fetch a PR, its full diff, and all related codebase context;
 * run a senior-developer quality AI review;
 * submit as a formal review (with inline comments) to the hosting provider.
 */
export async function runReviewWorkflow(
  gitx: Gitx,
  prNumber: number,
  postComment = true
): Promise<ReviewResult> {
  const ctx = await gitx.getRepoContext();
  const provider = createProvider(ctx);
  const cwd = gitx.cwd;

  logger.info(`🔍 Fetching PR #${prNumber}…`);
  const pr = await provider.getPR(ctx.repoSlug, prNumber);

  logger.info("💬 Fetching diff and comments…");
  const [comments, diff] = await Promise.all([
    provider.getPRComments(ctx.repoSlug, prNumber),
    provider.getPRDiff(ctx.repoSlug, prNumber),
  ]);

  // ── Build codebase context ─────────────────────────────────────────────────
  logger.info("📂 Building codebase context…");
  const allTracked = await listTrackedFiles(cwd);
  const changedPaths = parseChangedPathsFromDiff(diff);

  // Read full content of changed files
  const changedFiles: Record<string, string> = {};
  for (const p of changedPaths.slice(0, 12)) {
    const content = await readRepoFile(p, cwd);
    if (content) changedFiles[p] = content;
  }

  // Read supporting context files (imported by the changed files)
  const ctxPaths = await findContextFiles(changedPaths, allTracked, cwd, 8);
  const contextFiles: Record<string, string> = {};
  for (const p of ctxPaths) {
    const content = await readRepoFile(p, cwd);
    if (content) contextFiles[p] = content;
  }

  logger.info(
    `🧠 Running senior-dev AI review (${changedPaths.length} changed files, ${ctxPaths.length} context files)…`
  );

  const review = await gitx.ai.reviewPRDetailed({
    prTitle: pr.title,
    prBody: pr.body,
    author: pr.author,
    headBranch: pr.head,
    baseBranch: pr.base,
    diff,
    changedFiles,
    contextFiles,
    repoFileList: allTracked,
    existingComments: comments.map((c) => ({
      author: c.author,
      body: c.body,
      path: c.path,
      line: c.line,
    })),
  });

  // ── Build the formatted review body (for the summary comment) ─────────────
  const verdictIcon =
    review.verdict === "approve" ? "✅" :
    review.verdict === "request_changes" ? "🔴" : "💬";

  const checklistLines = review.checklist.map((c) => {
    const icon = c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️" : "❌";
    return `| ${icon} | **${c.area}** | ${c.note} |`;
  });

  const issueLines = review.issues.map((i) => {
    const sev = i.severity === "critical" ? "🔴" : i.severity === "warning" ? "🟡" : "💡";
    const loc = i.file ? ` (\`${i.file}${i.line ? `:${i.line}` : ""}\`)` : "";
    return `${sev} ${i.description}${loc}`;
  });

  const posLines = review.positives.map((p) => `✔ ${p}`);

  const summaryBody = [
    `## ${verdictIcon} Senior Dev AI Review (gitx) — ${review.verdict.replace("_", " ")}`,
    "",
    review.summary,
    ...(checklistLines.length > 0
      ? ["", "### Review Checklist", "| Status | Area | Note |", "|--------|------|------|", ...checklistLines]
      : []),
    ...(review.issues.length > 0 ? ["", "### Issues Found", ...issueLines] : []),
    ...(review.positives.length > 0 ? ["", "### Positives", ...posLines] : []),
    ...(review.testingNotes ? ["", "### How to Test", review.testingNotes] : []),
    ...(review.inlineComments.length > 0
      ? [`\n> 💬 ${review.inlineComments.length} inline comment(s) posted on specific lines.`]
      : []),
    "",
    "*Generated by [gitx](https://github.com/g-abhishek/gitx)*",
  ].join("\n");

  // ── Post the formal review (inline comments + verdict) ────────────────────
  if (postComment) {
    logger.info("📝 Submitting formal PR review with inline comments…");
    await provider.submitPRReview(ctx.repoSlug, prNumber, {
      body: summaryBody,
      event: review.verdict,
      comments: review.inlineComments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.suggestion
          ? `${c.body}\n\n**Suggestion:**\n\`\`\`suggestion\n${c.suggestion}\n\`\`\``
          : c.body,
      })),
    });
    logger.success("Review submitted to PR.");
  }

  return { pr, comments, aiSummary: summaryBody, review };
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
