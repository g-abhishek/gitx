import type { Command } from "commander";
import { registerPrListCommand } from "./list.js";
import { registerPrCreateCommand } from "./create.js";
import { registerPrReviewCommand } from "./review.js";
import { registerPrFixCommentsCommand } from "./fixComments.js";

export function registerPrCommands(program: Command): void {
  const pr = program.command("pr").description("🔀 Pull request commands");

  registerPrListCommand(pr);
  registerPrCreateCommand(pr);
  registerPrReviewCommand(pr);
  registerPrFixCommentsCommand(pr);
}

