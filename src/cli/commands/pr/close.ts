/**
 * gitx pr close <number>
 *
 * Close (or abandon on Azure DevOps) a pull request.
 *
 * Note: no provider's public API supports hard-deleting a PR.
 * GitHub/GitLab mark it "closed"; Azure DevOps marks it "abandoned".
 *
 * Usage:
 *   gitx pr close 42          # close PR #42 (prompts for confirmation)
 *   gitx pr close 42 --force  # skip confirmation prompt
 */

import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { createProvider } from "../../../providers/factory.js";
import { GitxError } from "../../../utils/errors.js";

export function registerPrCloseCommand(pr: Command): void {
  pr.command("close <number>")
    .description("🚫 Close (or abandon) a pull request")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (numberArg: string, opts: { force?: boolean }) => {
      const prNumber = parseInt(numberArg, 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        throw new GitxError(`Invalid PR number: "${numberArg}"`, { exitCode: 2 });
      }

      const gitx = await Gitx.fromCwd();
      const ctx = await gitx.getRepoContext();
      const provider = createProvider(ctx);

      // Fetch PR to show details before confirming
      const fetchSpinner = ora(`Fetching PR #${prNumber}…`).start();
      let pr_: Awaited<ReturnType<typeof provider.getPR>>;
      try {
        pr_ = await provider.getPR(ctx.repoSlug, prNumber);
        fetchSpinner.stop();
      } catch (err) {
        fetchSpinner.fail();
        throw err;
      }

      if (pr_.state !== "open") {
        logger.warn(`PR #${prNumber} is already ${pr_.state} — nothing to do.`);
        return;
      }

      // Show PR summary
      logger.info(`\n  #${pr_.number}  ${pr_.title}`);
      logger.info(`  Branch: ${pr_.head} → ${pr_.base}`);
      logger.info(`  Author: ${pr_.author}  |  ${pr_.url}\n`);

      // Determine provider-specific label for UX messaging
      const actionLabel = ctx.provider === "azure" ? "abandon" : "close";

      if (!opts.force) {
        const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
          {
            type: "confirm",
            name: "confirmed",
            message: `${actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1)} PR #${prNumber}?`,
            default: false,
          },
        ]);

        if (!confirmed) {
          logger.info("Aborted — PR left open.");
          return;
        }
      }

      const closeSpinner = ora(`Closing PR #${prNumber}…`).start();
      await provider.closePR(ctx.repoSlug, prNumber);
      closeSpinner.succeed(`PR #${prNumber} "${pr_.title}" has been ${actionLabel}d ✓`);
    });
}
