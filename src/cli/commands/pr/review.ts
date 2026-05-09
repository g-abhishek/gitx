import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { runReviewWorkflow } from "../../../workflows/pr.js";

export function registerPrReviewCommand(pr: Command): void {
  pr.command("review")
    .description("🧐 AI-powered pull request review")
    .argument("<id>", "Pull request number")
    .option("--no-comment", "Show review locally only — do not post to PR", false)
    .action(async (id: string, options: { comment: boolean }) => {
      const prNumber = parseInt(id, 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        logger.error(`Invalid PR number: ${id}`);
        process.exit(1);
      }

      const gitx = await Gitx.fromCwd();
      const ctx = await gitx.getRepoContext();
      logger.info(`🧐 Reviewing PR #${prNumber} on ${ctx.repoSlug}…\n`);

      const result = await runReviewWorkflow(gitx, prNumber, options.comment !== false);

      logger.info(`\n📋 PR: ${result.pr.title}`);
      logger.info(`   State:  ${result.pr.state}`);
      logger.info(`   Branch: ${result.pr.head} → ${result.pr.base}`);
      logger.info(`   Author: ${result.pr.author}`);
      logger.info(`   URL:    ${result.pr.url}`);

      if (result.comments.length > 0) {
        logger.info(`\n💬 Existing comments (${result.comments.length}):`);
        result.comments.slice(0, 5).forEach((c) => {
          logger.info(`  [${c.author}${c.path ? ` @ ${c.path}:${c.line ?? ""}` : ""}]: ${c.body.slice(0, 120)}…`);
        });
      }

      logger.info(`\n🤖 AI Review:\n${result.aiSummary}`);

      if (options.comment !== false) {
        logger.success("\n✅ AI review posted to PR.");
      }
    });
}
