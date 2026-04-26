import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";

export function registerPrReviewCommand(pr: Command): void {
  pr.command("review")
    .description("🧐 Review a pull request")
    .argument("<id>", "Pull request id/number")
    .action(async (id: string) => {
      logger.warn("Not implemented yet (provider system next).");
      logger.info(`PR: ${id}`);
    });
}

