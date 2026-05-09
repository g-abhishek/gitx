import type { Command } from "commander";
import { runSetup } from "./config.js";

/**
 * `gitx init` is an alias for `gitx config setup`.
 * Kept for discoverability and muscle memory.
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("🚀 Alias for `gitx config setup`")
    .action(async () => {
      await runSetup();
    });
}
