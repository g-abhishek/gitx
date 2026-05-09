import type { Command } from "commander";
import inquirer from "inquirer";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { runFixCommentsWorkflow } from "../../../workflows/pr.js";
import { pushBranch, getCurrentBranch, isWorkingTreeDirty } from "../../../utils/gitOps.js";

export function registerPrFixCommentsCommand(pr: Command): void {
  pr.command("fix-comments")
    .description("🩹 AI-fix review comments and push changes")
    .argument("<id>", "Pull request number")
    .option("--dry-run", "Preview fixes without applying or committing", false)
    .option("--no-push", "Apply & commit locally but skip push", false)
    .action(async (id: string, options: { dryRun: boolean; push: boolean }) => {
      const prNumber = parseInt(id, 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        logger.error(`Invalid PR number: ${id}`);
        process.exit(1);
      }

      const gitx = await Gitx.fromCwd();
      const ctx = await gitx.getRepoContext();
      logger.info(`🩹 Fixing review comments on PR #${prNumber} (${ctx.repoSlug})…\n`);

      // ── AI availability warning ────────────────────────────────────────────
      if (!process.env["ANTHROPIC_API_KEY"]) {
        logger.warn(
          "⚠️  ANTHROPIC_API_KEY is not set — AI fix suggestions will be empty.\n" +
          "   Export it first: export ANTHROPIC_API_KEY=sk-ant-..."
        );
        return;
      }


      if (!options.dryRun) {
        const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
          {
            type: "confirm",
            name: "proceed",
            message:
              "This will apply AI-suggested fixes, commit, and push. Continue?",
            default: false,
          },
        ]);
        if (!proceed) {
          logger.warn("Cancelled.");
          return;
        }
      }

      // ── Guard: warn about uncommitted changes ────────────────────────────
      if (!options.dryRun) {
        const dirty = await isWorkingTreeDirty(gitx.cwd);
        if (dirty) {
          logger.warn("⚠️  You have uncommitted changes. They may conflict with applied fixes.");
          const { cont } = await inquirer.prompt<{ cont: boolean }>([
            { type: "confirm", name: "cont", message: "Continue anyway?", default: false },
          ]);
          if (!cont) { logger.warn("Cancelled."); return; }
        }
      }

      const result = await runFixCommentsWorkflow(gitx, prNumber, options.dryRun);

      logger.info(`\n📋 PR: ${result.pr.title}`);

      if (result.appliedFixes.length === 0 && result.skippedFixes.length === 0) {
        logger.info("No actionable review comments found.");
        return;
      }

      if (result.appliedFixes.length > 0) {
        logger.success(`\n✅ Applied ${result.appliedFixes.length} fix(es):`);
        result.appliedFixes.forEach((f) => logger.info(`  • ${f.path} — ${f.rationale}`));
      }

      if (result.skippedFixes.length > 0) {
        logger.warn(`\n⚠️  Skipped ${result.skippedFixes.length} fix(es):`);
        result.skippedFixes.forEach((f) => logger.warn(`  • ${f.path}: ${f.reason}`));
      }

      // Push if not dry-run and push not disabled
      if (!options.dryRun && options.push !== false && result.appliedFixes.length > 0) {
        const branch = await getCurrentBranch(gitx.cwd);
        logger.info(`\n🚀 Pushing ${branch}…`);
        try {
          await pushBranch(branch, gitx.cwd);
          logger.success("Branch pushed.");
        } catch (err) {
          logger.warn(`Push failed: ${String((err as Error).message ?? err)}`);
        }
      }
    });
}
