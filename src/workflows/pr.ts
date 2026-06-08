/**
 * PR Workflow helpers
 *
 * Shared logic used by the `pr review` and `pr fix-comments` CLI commands.
 */

import ora from "ora";
import type { Gitx } from "../core/gitx.js";
import type { PullRequest, PullRequestComment } from "../providers/base.js";
import { createProvider } from "../providers/factory.js";
import { readRepoFile, listTrackedFiles } from "../utils/gitOps.js";
import { logger } from "../logger/logger.js";

// Files that add no review value — skip them even if they appear in the diff
const SKIP_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /bun\.lockb$/,
  /\.lock$/,
  /dist\//,
  /build\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /node_modules\//,
  /\.d\.ts$/,     // generated TypeScript declarations
  /generated\//,
  /migrations\/.*\.sql$/,
];

function isReviewableFile(path: string): boolean {
  return !SKIP_FILE_PATTERNS.some((re) => re.test(path));
}

// ─── Review workflow ──────────────────────────────────────────────────────────

export interface ReviewResult {
  pr: PullRequest;
  comments: PullRequestComment[];
  aiSummary: string;
  review?: import("../ai/types.js").AiDetailedReviewResponse;
  /** true = review was actually posted to the hosting provider */
  reviewPosted: boolean;
  /** How inline comments were delivered: formal inline, plain comments, or not posted */
  inlineDelivery: "inline" | "plain-comments" | "none";
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

  const fetchSpinner = ora("Fetching PR info, diff and comments…").start();
  const pr = await provider.getPR(ctx.repoSlug, prNumber);
  const [comments, diff] = await Promise.all([
    provider.getPRComments(ctx.repoSlug, prNumber),
    provider.getPRDiff(ctx.repoSlug, prNumber),
  ]);
  fetchSpinner.succeed(`PR #${prNumber}: "${pr.title}"  (${pr.head} → ${pr.base})`);

  // ── Build codebase context ─────────────────────────────────────────────────
  const ctxSpinner = ora("Building codebase context from changed files…").start();
  const allTracked = await listTrackedFiles(cwd);
  const allChangedPaths = parseChangedPathsFromDiff(diff);

  // Filter out lockfiles / generated files — they waste tokens and add no review value.
  // No file count cap — per-file budgets in buildSeniorReviewPrompt already control
  // total size. Dropping files arbitrarily is worse than sending all of them.
  const changedPaths = allChangedPaths.filter(isReviewableFile);
  const skippedCount = allChangedPaths.length - changedPaths.length;

  // Read full content of changed files
  const changedFiles: Record<string, string> = {};
  for (const p of changedPaths) {
    const content = await readRepoFile(p, cwd);
    if (content) changedFiles[p] = content;
  }

  // Read supporting context files (imported by the changed files)
  // 10 context files gives the AI a solid picture of the codebase structure
  const ctxPaths = await findContextFiles(changedPaths, allTracked, cwd, 10);
  const contextFiles: Record<string, string> = {};
  for (const p of ctxPaths) {
    const content = await readRepoFile(p, cwd);
    if (content) contextFiles[p] = content;
  }

  const skippedNote = skippedCount > 0 ? `, ${skippedCount} lock/generated files skipped` : "";
  ctxSpinner.succeed(
    `Context: ${changedPaths.length} changed files, ${ctxPaths.length} context files${skippedNote}`
  );

  const reviewSpinner = ora(
    `Running senior-dev AI review… (this may take up to 5 min for large PRs)`
  ).start();

  let review: Awaited<ReturnType<typeof gitx.ai.reviewPRDetailed>>;
  try {
    review = await gitx.ai.reviewPRDetailed({
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
    reviewSpinner.succeed(
      `Review complete — verdict: ${review.verdict}  |  ${review.inlineComments.length} inline comment(s)`
    );
  } catch (err) {
    reviewSpinner.fail("AI review failed.");
    throw err;
  }

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
  let reviewPosted = false;
  let inlineDelivery: ReviewResult["inlineDelivery"] = "none";

  if (postComment) {
    const inlineCount = review.inlineComments.length;
    const postSpinner = ora(
      `Submitting review to PR${inlineCount > 0 ? ` with ${inlineCount} inline comment(s)` : ""}…`
    ).start();
    try {
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
      reviewPosted = true;
      // Determine how inline comments were delivered.
      // GitHub's submitPRReview will attempt inline first, then fall back to
      // plain comments. We can't detect which path was taken from here, so
      // we report "inline" optimistically — the user sees the real result on GitHub.
      inlineDelivery = inlineCount > 0 ? "inline" : "none";
      postSpinner.succeed(
        `Review submitted to PR.${inlineCount > 0 ? ` (${inlineCount} inline comment(s) — see PR for delivery method)` : ""}`
      );
    } catch (err) {
      postSpinner.fail(`Could not post review to PR: ${String((err as Error).message ?? err)}`);
      // Don't rethrow — still return the review so the user can see it locally
    }
  }

  return { pr, comments, aiSummary: summaryBody, review, reviewPosted, inlineDelivery };
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
  dryRun = false,
  noCommit = false
): Promise<FixCommentsResult> {
  const { applyUnifiedDiff, stageAll, hasStagedChanges, commitChanges } = await import(
    "../utils/gitOps.js"
  );
  const cwd = gitx.cwd;
  const ctx = await gitx.getRepoContext();
  const provider = createProvider(ctx);

  const fetchSpinner = ora("Fetching PR, comments and diff…").start();
  const pr = await provider.getPR(ctx.repoSlug, prNumber);
  const [comments, diff] = await Promise.all([
    provider.getPRComments(ctx.repoSlug, prNumber),
    provider.getPRDiff(ctx.repoSlug, prNumber),
  ]);
  fetchSpinner.succeed(`PR #${prNumber}: "${pr.title}"  —  ${comments.length} comment(s)`);

  if (comments.length === 0) {
    logger.info("No review comments found.");
    return { pr, comments, appliedFixes: [], skippedFixes: [] };
  }

  // ── Build file context ────────────────────────────────────────────────────
  // Only load files directly mentioned in comments + their close imports.
  // Random repo source files are irrelevant — the AI is fixing specific lines.
  const ctxSpinner = ora("Building file context for commented files…").start();

  const mentionedPaths = [...new Set(comments.map((c) => c.path).filter(Boolean) as string[])];
  const trackedFiles = await listTrackedFiles(cwd);

  // File content strategy — same thresholds as the review workflow:
  //   ≤ FULL_FILE_THRESHOLD lines  → send the whole file (AI needs full context to make correct edits)
  //   larger files                 → show a generous window around each commented line
  const FULL_FILE_THRESHOLD = 400;
  const COMMENT_WINDOW      = 80;   // lines above/below a commented line in large files
  const CTX_FILE_MAX        = 4_000; // chars per supporting context file

  const fileContents: Record<string, string> = {};

  // Commented lines per file — used for smart windowing on large files
  const commentedLines: Record<string, number[]> = {};
  for (const c of comments) {
    if (c.path && c.line) {
      (commentedLines[c.path] ??= []).push(c.line);
    }
  }

  for (const filePath of mentionedPaths) {
    const content = await readRepoFile(filePath, cwd);
    if (!content) continue;

    const lines = content.split("\n");
    if (lines.length <= FULL_FILE_THRESHOLD) {
      // Small file — send it whole
      fileContents[filePath] = lines
        .map((l, i) => `${String(i + 1).padStart(5, " ")} | ${l}`)
        .join("\n");
    } else {
      // Large file — show windows around commented lines
      const targets = commentedLines[filePath] ?? [];
      const included = new Set<number>();
      for (const line of targets) {
        for (let i = Math.max(0, line - COMMENT_WINDOW - 1); i < Math.min(lines.length, line + COMMENT_WINDOW); i++) {
          included.add(i);
        }
      }
      // If no specific lines, fall back to first FULL_FILE_THRESHOLD lines
      const indices = included.size > 0 ? [...included].sort((a, b) => a - b) : [...Array(FULL_FILE_THRESHOLD).keys()];
      let excerpt = "";
      let prev = -1;
      for (const idx of indices) {
        if (prev !== -1 && idx > prev + 1) excerpt += `\n      … (${idx - prev - 1} lines omitted)\n`;
        excerpt += `${String(idx + 1).padStart(5, " ")} | ${lines[idx]}\n`;
        prev = idx;
      }
      fileContents[filePath] = excerpt.trimEnd();
    }
  }

  // Add context files (imports of the mentioned files) for extra background
  const ctxPaths = await findContextFiles(mentionedPaths, trackedFiles, cwd, 8);
  for (const filePath of ctxPaths) {
    if (fileContents[filePath]) continue; // already loaded
    const content = await readRepoFile(filePath, cwd);
    if (!content) continue;
    fileContents[filePath] = content.length <= CTX_FILE_MAX
      ? content
      : content.slice(0, CTX_FILE_MAX) + "\n… (truncated)";
  }

  ctxSpinner.succeed(
    `Context: ${mentionedPaths.length} commented file(s), ${ctxPaths.length} context file(s)`
  );

  const fixSpinner = ora("🧠 Generating AI-suggested fixes…").start();
  const fixResult = await gitx.ai.suggestFixes({
    comments: comments.map((c) => ({
      body: c.body,
      author: c.author,
      path: c.path,
      line: c.line,
    })),
    prTitle: pr.title,
    prBody: pr.body,
    diff,
    fileContents,
  });
  fixSpinner.succeed(`AI generated ${fixResult.suggestedEdits.length} fix(es).`);

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

  if (!dryRun && !noCommit && appliedFixes.length > 0) {
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

  if (!dryRun && noCommit && appliedFixes.length > 0) {
    logger.info("\n💡 Fixes applied to working tree. Review the changes and commit when ready.");
  }

  return { pr, comments, appliedFixes, skippedFixes };
}
