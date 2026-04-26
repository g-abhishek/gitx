import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerImplementCommand } from "./commands/implement.js";
import { registerPrCommands } from "./commands/pr/index.js";
import { logger } from "../logger/logger.js";
import { GitxError } from "../utils/errors.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("gitx")
    .description("🧠🤝 AI-powered Git workflow automation CLI")
    .version("0.1.0");

  registerInitCommand(program);
  registerImplementCommand(program);
  registerPrCommands(program);

  program.showHelpAfterError(true);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof GitxError) {
      logger.error(error.message);
      if (error.cause) logger.warn(`Cause: ${String(error.cause)}`);
      process.exitCode = error.exitCode;
      return;
    }

    logger.error("Unexpected error");
    logger.error(String(error));
    process.exitCode = 1;
  }
}

