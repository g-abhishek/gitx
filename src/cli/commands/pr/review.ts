import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { runReviewWorkflow } from "../../../workflows/pr.js";

export function registerPrReviewCommand(pr: Command): void {
  pr.command("review")
    .description("🧐 AI-powered pull request review")
    .argument("<id>", "Pull request number")
    .option("--no-comment", "Show review locally only — do not post to PR")
    .action(async (id: string, options: { comment: boolean }) => {
      const prNumber = parseInt(id, 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        logger.error(`Invalid PR number: ${id}`);
        process.exit(1);
      }

      const gitx = await Gitx.fromCwd();
      const ctx = await gitx.getRepoContext();

      // ── AI availability warning ────────────────────────────────────────────
      if (!process.env["ANTHROPIC_API_KEY"]) {
        logger.warn(
          "⚠️  ANTHROPIC_API_KEY is not set — AI review will not be meaningful.\n" +
          "   Export it first: export ANTHROPIC_API_KEY=sk-ant-..."
        );
        return;
      }

      const postComment = options.comment !== false;
      logger.info(`🧐 Reviewing PR #${prNumber} on ${ctx.repoSlug}…\n`);

      const result = await runReviewWorkflow(gitx, prNumber, postComment);
      const review = result.review;

      // ── PR info ───────────────────────────────────────────────────────────
      logger.info(`📋 ${result.pr.title}`);
      logger.info(`   ${result.pr.head} → ${result.pr.base}  ·  by ${result.pr.author}  ·  ${result.pr.state}`);
      logger.info(`   ${result.pr.url}\n`);

      if (!review) {
        logger.info(`🤖 Review:\n${result.aiSummary}`);
        return;
      }

      // ── Structured review output ──────────────────────────────────────────
      const verdictIcon =
        review.verdict === "approve" ? "✅ Approve" :
        review.verdict === "request_changes" ? "🔴 Request Changes" : "💬 Comment";

      logger.info(`🤖 AI Verdict: ${verdictIcon}\n`);
      logger.info(`📝 ${review.summary}\n`);

      if (review.issues.length > 0) {
        logger.info(`🔎 Issues (${review.issues.length}):`);
        review.issues.forEach((issue) => {
          const icon = issue.severity === "critical" ? "🔴" : issue.severity === "warning" ? "🟡" : "💡";
          const loc = issue.file ? `  [${issue.file}${issue.line ? `:${issue.line}` : ""}]` : "";
          logger.info(`  ${icon} ${issue.description}${loc}`);
        });
        logger.info("");
      }

      if (review.positives.length > 0) {
        logger.info(`👍 Positives:`);
        review.positives.forEach((p) => logger.info(`  ✔ ${p}`));
        logger.info("");
      }

      if (result.comments.length > 0) {
        logger.info(`💬 Existing comments (${result.comments.length}):`);
        result.comments.slice(0, 3).forEach((c) => {
          const loc = c.path ? ` @ ${c.path}${c.line ? `:${c.line}` : ""}` : "";
          logger.info(`  [${c.author}${loc}]: ${c.body.slice(0, 100)}${c.body.length > 100 ? "…" : ""}`);
        });
        logger.info("");
      }

      if (postComment) {
        logger.success("✅ AI review posted to PR.");
      } else {
        logger.info("ℹ️  Review shown locally only (--no-comment).");
      }
    });
}
