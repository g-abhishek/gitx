import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";

export function registerPrListCommand(pr: Command): void {
  pr.command("list")
    .description("📋 List pull requests")
    .action(async () => {
      logger.warn("Not implemented yet (provider system next).");
    });
}

