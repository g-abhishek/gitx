import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";

export function registerPrFixCommentsCommand(pr: Command): void {
  pr.command("fix-comments")
    .description("🩹 Attempt to fix PR review comments")
    .argument("<id>", "Pull request id/number")
    .action(async (id: string) => {
      const gitx = await Gitx.fromCwd();
      await gitx.getRepoContext();
      logger.warn("Not implemented yet (AI + provider wiring next).");
      logger.info(`PR: ${id}`);
    });
}
