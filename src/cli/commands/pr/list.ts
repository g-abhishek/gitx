import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";

export function registerPrListCommand(pr: Command): void {
  pr.command("list")
    .description("📋 List pull requests")
    .action(async () => {
      const gitx = await Gitx.fromCwd();
      await gitx.getRepoContext();
      logger.warn("Not implemented yet (provider system next).");
    });
}
