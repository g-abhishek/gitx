import type { Command } from "commander";
import { registerPrListCommand } from "./list.js";
import { registerPrCreateCommand } from "./create.js";
import { registerPrReviewCommand } from "./review.js";
import { registerPrResolveCommand } from "./resolve.js";
import { registerPrCloseCommand } from "./close.js";
import { registerPrMergeCommand } from "./merge.js";

export function registerPrCommands(program: Command): void {
  const pr = program.command("pr").description("🔀 Pull request commands");

  registerPrListCommand(pr);
  registerPrCreateCommand(pr);
  registerPrMergeCommand(pr);
  registerPrReviewCommand(pr);
  registerPrResolveCommand(pr);
  registerPrCloseCommand(pr);
}
