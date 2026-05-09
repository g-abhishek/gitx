import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { runReviewWorkflow } from "../../../workflows/pr.js";

export function registerPrReviewCommand(pr: Command): void {
  pr.command("review")
    .description("🧐 Senior-dev AI review: inline comments, checklist, verdict")
    .argument("<id>", "Pull request number")
    .option("--no-comment", "Show review locally only — do not post to PR")
    .option("--no-inline", "Post overall review but skip inline file comments")
    .action(async (id: string, options: { comment: boolean; inline: boolean }) => {
      const prNumber = parseInt(id, 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        logger.error(`Invalid PR number: ${id}`);
        process.exit(1);
      }

      const gitx = await Gitx.fromCwd();

      if (!Gitx.isAiAvailable(gitx.config)) {
        logger.warn(
          "⚠️  No AI provider configured — review will not be meaningful.\n" +
          "   Run: gitx config set anthropic   (or openai / claude-cli)"
        );
        return;
      }

      const postComment = options.comment !== false;

      logger.info(`\n🧐 Running senior-dev AI review on PR #${prNumber}…\n`);

      let result: Awaited<ReturnType<typeof runReviewWorkflow>>;
      try {
        result = await runReviewWorkflow(gitx, prNumber, postComment);
      } catch (err) {
        logger.error(`Review failed: ${String((err as Error).message ?? err)}`);
        process.exitCode = 1;
        return;
      }

      const { pr: pullReq, review, comments } = result;

      // ── PR header ─────────────────────────────────────────────────────────
      logger.info(`\n📋  ${pullReq.title}`);
      logger.info(`    ${pullReq.head} → ${pullReq.base}  ·  by ${pullReq.author}  ·  ${pullReq.state}`);
      logger.info(`    ${pullReq.url}\n`);

      if (!review) {
        logger.info(`🤖 Review:\n${result.aiSummary}`);
        return;
      }

      // ── Verdict ───────────────────────────────────────────────────────────
      const verdictIcon =
        review.verdict === "approve"
          ? "✅  APPROVE"
          : review.verdict === "request_changes"
          ? "🔴  REQUEST CHANGES"
          : "💬  COMMENT";

      logger.info(`🤖 Verdict: ${verdictIcon}\n`);

      // ── Summary ───────────────────────────────────────────────────────────
      logger.info(`📝 Summary:\n   ${review.summary.replace(/\n/g, "\n   ")}\n`);

      // ── Checklist ─────────────────────────────────────────────────────────
      if (review.checklist.length > 0) {
        logger.info("✅ Review Checklist:");
        for (const item of review.checklist) {
          const icon = item.status === "pass" ? "✅" : item.status === "warn" ? "⚠️ " : "❌";
          logger.info(`   ${icon}  ${item.area.padEnd(20)} ${item.note}`);
        }
        logger.info("");
      }

      // ── Issues ────────────────────────────────────────────────────────────
      const criticals = review.issues.filter((i) => i.severity === "critical");
      const warnings  = review.issues.filter((i) => i.severity === "warning");
      const suggestions = review.issues.filter((i) => i.severity === "suggestion");

      if (review.issues.length > 0) {
        logger.info(`🔎 Issues (${review.issues.length}):`);
        for (const issue of [...criticals, ...warnings, ...suggestions]) {
          const icon = issue.severity === "critical" ? "🔴" : issue.severity === "warning" ? "🟡" : "💡";
          const loc = issue.file ? `  [${issue.file}${issue.line ? `:${issue.line}` : ""}]` : "";
          logger.info(`   ${icon} ${issue.description}${loc}`);
        }
        logger.info("");
      }

      // ── Inline comments ───────────────────────────────────────────────────
      if (review.inlineComments.length > 0) {
        logger.info(`💬 Inline Comments (${review.inlineComments.length}):`);
        for (const c of review.inlineComments) {
          const icon = c.severity === "critical" ? "🔴" : c.severity === "warning" ? "🟡" : "💡";
          logger.info(`\n   ${icon} ${c.path}:${c.line}`);
          logger.info(`      ${c.body.replace(/\n/g, "\n      ")}`);
          if (c.suggestion) {
            logger.info(`      📌 Suggestion: ${c.suggestion.split("\n")[0]}…`);
          }
        }
        logger.info("");
      }

      // ── Positives ─────────────────────────────────────────────────────────
      if (review.positives.length > 0) {
        logger.info("👍 Positives:");
        for (const p of review.positives) logger.info(`   ✔  ${p}`);
        logger.info("");
      }

      // ── Testing notes ─────────────────────────────────────────────────────
      if (review.testingNotes) {
        logger.info(`🧪 How to test:\n   ${review.testingNotes.replace(/\n/g, "\n   ")}\n`);
      }

      // ── Existing PR comments ──────────────────────────────────────────────
      if (comments.length > 0) {
        logger.info(`💬 Existing comments on PR (${comments.length}):`);
        for (const c of comments.slice(0, 4)) {
          const loc = c.path ? ` @ ${c.path}${c.line ? `:${c.line}` : ""}` : "";
          logger.info(
            `   [${c.author}${loc}]: ${c.body.slice(0, 120)}${c.body.length > 120 ? "…" : ""}`
          );
        }
        if (comments.length > 4) logger.info(`   … and ${comments.length - 4} more.`);
        logger.info("");
      }

      // ── Status ────────────────────────────────────────────────────────────
      if (postComment) {
        logger.success(
          `✅ Review submitted to PR with ${review.inlineComments.length} inline comment(s).`
        );
      } else {
        logger.info("ℹ️  Review shown locally only (--no-comment).");
      }
    });
}
