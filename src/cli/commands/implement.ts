import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../logger/logger.js";
import type { AutonomyMode } from "../../types/modes.js";
import { Gitx } from "../../core/gitx.js";
import { assertValid, validateNonEmpty } from "../../utils/validators.js";
import { parseAutonomyMode } from "../../utils/modes.js";

export function registerImplementCommand(program: Command): void {
  program
    .command("implement")
    .description("🛠️ Implement a task with AI assistance")
    .argument("<task>", "Task description")
    .option("--mode <mode>", "plan|guided|semi-auto|auto", "guided")
    .option("--dry-run", "Simulate execution (no changes)", false)
    .action(async (task: string, options: { mode: AutonomyMode; dryRun: boolean }) => {
      assertValid(validateNonEmpty("Task")(task), "Task");
      const mode = parseAutonomyMode(options.mode);

      const gitx = await Gitx.fromCwd();
      const ctx = await gitx.getRepoContext();
      logger.info(`📦 Repo: ${ctx.repoSlug}`);
      logger.info(`🔌 Provider: ${ctx.provider}`);

      const spinner = ora("🧠 Analyzing task…").start();
      const analysis = await gitx.ai.analyzeTask(task);
      spinner.succeed("Task analyzed");

      logger.info("🧾 Summary");
      logger.info(JSON.stringify(analysis, null, 2));

      const planSpinner = ora("🗺️ Generating plan…").start();
      const plan = await gitx.ai.generatePlan({ task, analysis });
      planSpinner.succeed("Plan generated");

      logger.info("🧩 Plan");
      logger.info(JSON.stringify(plan, null, 2));

      if (mode !== "auto") {
        const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
          {
            type: "confirm",
            name: "proceed",
            message: options.dryRun
              ? "Proceed with dry-run execution?"
              : "Proceed with execution (branch + commit + PR)?",
            default: false
          }
        ]);
        if (!proceed) {
          logger.warn("⏹️ Cancelled");
          return;
        }
      }

      logger.warn("⚠️ implement flow execution is not wired yet (providers + git ops in next step).");
      logger.info(`Mode: ${mode}, dry-run: ${options.dryRun ? "yes" : "no"}`);
    });
}
