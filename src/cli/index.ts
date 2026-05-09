import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerCommitCommand } from "./commands/commit.js";
import { registerPushCommand } from "./commands/push.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerImplementCommand } from "./commands/implement.js";
import { registerPrCommands } from "./commands/pr/index.js";
import { registerConfigCommand } from "./commands/config.js";
import { logger } from "../logger/logger.js";
import { GitxError } from "../utils/errors.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("gitx")
    .description("🧠🤝 AI-powered Git workflow automation CLI")
    .version("0.1.3");

  registerInitCommand(program);
  registerCommitCommand(program);
  registerPushCommand(program);
  registerSyncCommand(program);
  registerConfigCommand(program);
  registerImplementCommand(program);
  registerPrCommands(program);

  program.showHelpAfterError(true);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof GitxError) {
      logger.error(`\n${error.message}`);
      // Only show the cause if it adds useful info (not just an AxiosError wrapper)
      if (error.cause && !(error.cause instanceof Error && error.message.includes((error.cause as Error).message))) {
        const causeMsg = error.cause instanceof Error
          ? error.cause.message
          : String(error.cause);
        // Strip noisy internal prefixes
        const clean = causeMsg.replace(/^AxiosError:\s*/i, "").replace(/^Error:\s*/i, "");
        if (clean && clean !== error.message) {
          logger.warn(`Details: ${clean}`);
        }
      }
      process.exitCode = error.exitCode;
      return;
    }

    // Unknown errors — show cleanly without a stack dump
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`\nUnexpected error: ${msg}`);
    if (process.env["GITX_DEBUG"]) {
      console.error(error);
    } else {
      logger.warn("Set GITX_DEBUG=1 for full stack trace.");
    }
    process.exitCode = 1;
  }
}
