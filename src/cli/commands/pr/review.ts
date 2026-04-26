import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";

export function registerPrReviewCommand(pr: Command): void {
  pr.command("review")
    .description("🧐 Review a pull request")
    .argument("<id>", "Pull request id/number")
    .action(async (id: string) => {
      const gitx = await Gitx.fromCwd();
      await gitx.getRepoContext();
      logger.warn("Not implemented yet (provider system next).");
      logger.info(`PR: ${id}`);
    });
}
