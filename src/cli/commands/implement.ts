import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../logger/logger.js";
import type { AutonomyMode } from "../../types/modes.js";
import { Gitx } from "../../core/gitx.js";
import { assertValid, validateNonEmpty } from "../../utils/validators.js";
import { parseAutonomyMode } from "../../utils/modes.js";
import { runImplementWorkflow } from "../../workflows/implement.js";
import { isWorkingTreeDirty } from "../../utils/gitOps.js";
import type { AiAnalyzeTaskResponse, AiGeneratePlanResponse } from "../../ai/types.js";

export function registerImplementCommand(program: Command): void {
  program
    .command("implement")
    .description("🛠️  Implement a task with AI assistance")
    .argument("<task>", "Task description")
    .option("--mode <mode>", "plan|guided|semi-auto|auto", "guided")
    .option("--dry-run", "Simulate execution — no files changed, no commits", false)
    .action(async (task: string, options: { mode: string; dryRun: boolean }) => {
      assertValid(validateNonEmpty("Task")(task), "Task");
      const mode = parseAutonomyMode(options.mode) as AutonomyMode;
      const dryRun = options.dryRun;

      const initSpinner = ora("Loading config & repo context…").start();
      let gitx: Gitx;
      try {
        gitx = await Gitx.fromCwd();
        const ctx = await gitx.getRepoContext();
        initSpinner.succeed(`Repo: ${ctx.repoSlug}  Provider: ${ctx.provider}`);
      } catch (err) {
        initSpinner.fail("Failed to load context");
        throw err;
      }

      // ── Guard: warn if AI is not available ─────────────────────────────────
      if (!process.env["ANTHROPIC_API_KEY"]) {
        logger.warn(
          "⚠️  ANTHROPIC_API_KEY is not set. AI responses will be mocked placeholders.\n" +
          "   Export it to use real Claude: export ANTHROPIC_API_KEY=sk-ant-..."
        );
        if (mode !== "plan") {
          const { continueAnyway } = await (await import("inquirer")).default.prompt<{ continueAnyway: boolean }>([
            { type: "confirm", name: "continueAnyway", message: "Continue with mock AI anyway?", default: false },
          ]);
          if (!continueAnyway) { logger.warn("Cancelled."); return; }
        }
      }

      // ── Guard: uncommitted changes would be lost when we create a branch ───
      if (mode !== "plan" && !options.dryRun) {
        const dirty = await isWorkingTreeDirty(gitx.cwd);
        if (dirty) {
          logger.warn("⚠️  You have uncommitted changes in your working tree.");
          const { action } = await (await import("inquirer")).default.prompt<{ action: string }>([
            {
              type: "list",
              name: "action",
              message: "How do you want to handle them?",
              choices: [
                { name: "Stash them (git stash) and continue", value: "stash" },
                { name: "Cancel and handle them manually", value: "cancel" },
              ],
            },
          ]);
          if (action === "cancel") { logger.warn("Cancelled."); return; }
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          await promisify(execFile)("git", ["stash", "--include-untracked"], { cwd: gitx.cwd });
          logger.success("Changes stashed. Run `git stash pop` to restore them after.");
        }
      }

      // ── mode: plan ─────────────────────────────────────────────────────────
      if (mode === "plan") {
        const spinner = ora("🧠 Analyzing task…").start();
        const analysis = await gitx.ai.analyzeTask(task);
        spinner.succeed("Task analyzed");
        printAnalysis(analysis);

        const planSpinner = ora("🗺️  Generating plan…").start();
        const plan = await gitx.ai.generatePlan({ task, analysis });
        planSpinner.succeed("Plan generated");
        printPlan(plan);

        logger.info("\n💡 Run with --mode=guided or --mode=auto to execute.");
        return;
      }

      // ── modes: guided / semi-auto / auto ──────────────────────────────────
      const result = await runImplementWorkflow(gitx, {
        task,
        mode,
        dryRun,

        onAnalysis: async (analysis: AiAnalyzeTaskResponse): Promise<boolean> => {
          printAnalysis(analysis);
          if (mode === "guided") {
            const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
              {
                type: "confirm",
                name: "proceed",
                message: "Continue with this analysis and generate a plan?",
                default: true,
              },
            ]);
            return proceed;
          }
          return true;
        },

        onPlan: async (plan: AiGeneratePlanResponse): Promise<boolean> => {
          printPlan(plan);
          if (mode === "guided" || mode === "semi-auto") {
            const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
              {
                type: "confirm",
                name: "proceed",
                message: dryRun
                  ? "Proceed with dry-run (preview diffs only)?"
                  : "Proceed with execution (create branch + commit + push + PR)?",
                default: false,
              },
            ]);
            return proceed;
          }
          return true;
        },
      });

      // ── Show result ────────────────────────────────────────────────────────
      if (result.dryRun) {
        logger.info("\n🏁 Dry-run complete. No real changes were made.");
        if (result.appliedSteps.length > 0) {
          logger.info(`Would have applied steps: ${result.appliedSteps.join(", ")}`);
        }
        return;
      }

      if (!result.commitSha) {
        logger.warn("\n⚠️  No changes were committed. AI did not produce applicable diffs.");
        return;
      }

      logger.success("\n✅ Implementation complete!");
      logger.info(`Branch:  ${result.branchName}`);
      logger.info(`Commit:  ${result.commitSha?.slice(0, 8) ?? "–"}`);

      if (result.pr) {
        logger.success(`PR:      ${result.pr.url}`);
      }

      if (result.failedSteps.length > 0) {
        logger.warn(`\n⚠️  Some steps failed to apply:`);
        for (const f of result.failedSteps) {
          logger.warn(`  • ${f.stepId}: ${f.error}`);
        }
      }
    });
}

// ─── Display helpers ──────────────────────────────────────────────────────────

function printAnalysis(analysis: AiAnalyzeTaskResponse): void {
  logger.info(`\n🧾 Analysis`);
  logger.info(`  Intent:  ${analysis.intent}`);
  logger.info(`  Summary: ${analysis.summary}`);
  if (analysis.assumptions.length > 0) {
    logger.info(`  Assumptions:`);
    analysis.assumptions.forEach((a) => logger.info(`    • ${a}`));
  }
  if (analysis.risks.length > 0) {
    logger.info(`  Risks:`);
    analysis.risks.forEach((r) => logger.warn(`    ⚠ ${r}`));
  }
}

function printPlan(plan: AiGeneratePlanResponse): void {
  logger.info(`\n🧩 Plan (${plan.steps.length} steps)`);
  plan.steps.forEach((s, i) => {
    logger.info(`  ${i + 1}. [${s.id}] ${s.title}`);
    logger.info(`     ${s.description}`);
  });
}
