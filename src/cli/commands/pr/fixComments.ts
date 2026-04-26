import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";

export function registerPrFixCommentsCommand(pr: Command): void {
  pr.command("fix-comments")
    .description("🩹 Attempt to fix PR review comments")
    .argument("<id>", "Pull request id/number")
    .action(async (id: string) => {
      logger.warn("Not implemented yet (AI + provider wiring next).");
      logger.info(`PR: ${id}`);
    });
}

