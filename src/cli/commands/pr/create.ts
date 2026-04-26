import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";

export function registerPrCreateCommand(pr: Command): void {
  pr.command("create")
    .description("🆕 Create a pull request")
    .option("--branches <branches>", "Comma-separated branches (e.g. dev,staging,prod)")
    .action(async (options: { branches?: string }) => {
      const gitx = await Gitx.fromCwd();
      await gitx.getRepoContext();
      logger.warn("Not implemented yet (provider system next).");
      if (options.branches) logger.info(`Branches: ${options.branches}`);
    });
}
