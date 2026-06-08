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
import {
  fetchJiraTicket,
  buildTaskFromTicket,
  resolveTicketId,
  addJiraComment,
  transitionJiraTicket,
} from "../../utils/jira.js";

export function registerImplementCommand(program: Command): void {
  program
    .command("implement")
    .description("🛠️  Implement a task with AI assistance")
    .argument("[task]", "Task description (omit when using --jira)")
    .option("--mode <mode>", "plan|guided|semi-auto|auto", "guided")
    .option("--dry-run", "Simulate execution — no files changed, no commits", false)
    .option("--jira <ticket-id>", "Load the task from a Jira ticket (e.g. PROJ-123 or just 123 if projectKey is configured)")
    .option("--jira-comment", "Post a comment on the Jira ticket with the PR URL when done", false)
    .option("--jira-transition <status>", "Transition the Jira ticket to this status after PR is created (e.g. \"In Progress\")")
    .action(async (
      taskArg: string | undefined,
      options: {
        mode: string;
        dryRun: boolean;
        jira?: string;
        jiraComment?: boolean;
        jiraTransition?: string;
      }
    ) => {
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

      // ── Resolve the task description ──────────────────────────────────────
      let task: string;
      let jiraTicketKey: string | undefined;

      if (options.jira) {
        // ── Jira mode: fetch ticket and build task from it ───────────────────
        if (!gitx.config.jira) {
          logger.error(
            "❌ Jira is not configured. Run `gitx config set jira` to set up your credentials."
          );
          process.exitCode = 1;
          return;
        }

        const ticketId = resolveTicketId(options.jira, gitx.config.jira);
        jiraTicketKey = ticketId;

        const jiraSpinner = ora(`Fetching Jira ticket ${ticketId}…`).start();
        try {
          const ticket = await fetchJiraTicket(ticketId, gitx.config.jira);
          task = buildTaskFromTicket(ticket);
          jiraSpinner.succeed(
            `Loaded ${ticketId}: "${ticket.summary}" (${ticket.type} · ${ticket.status})`
          );
          if (ticket.assignee) logger.info(`   Assignee: ${ticket.assignee}`);
          if (ticket.subtasks.length > 0) logger.info(`   Subtasks: ${ticket.subtasks.length}`);
        } catch (err: unknown) {
          jiraSpinner.fail(`Failed to fetch Jira ticket: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          return;
        }
      } else {
        // ── Manual task mode ─────────────────────────────────────────────────
        if (!taskArg) {
          logger.error("❌ Provide a task description or use --jira <ticket-id>.");
          process.exitCode = 1;
          return;
        }
        assertValid(validateNonEmpty("Task")(taskArg), "Task");
        task = taskArg;
      }

      // ── Guard: warn if AI is not available ─────────────────────────────────
      if (!await Gitx.isAiAvailable(gitx.config)) {
        logger.warn(
          "⚠️  No AI provider configured — responses will be mocked placeholders.\n" +
          "   Run `gitx config` to set up an AI provider (Claude, OpenAI, or claude-cli)."
        );
        if (mode !== "plan") {
          const { continueAnyway } = await inquirer.prompt<{ continueAnyway: boolean }>([
            { type: "confirm", name: "continueAnyway", message: "Continue with mock AI anyway?", default: false },
          ]);
          if (!continueAnyway) { logger.warn("Cancelled."); return; }
        }
      }

      // ── Guard: uncommitted changes ─────────────────────────────────────────
      if (mode !== "plan" && !options.dryRun) {
        const dirty = await isWorkingTreeDirty(gitx.cwd);
        if (dirty) {
          logger.warn("⚠️  You have uncommitted changes in your working tree.");
          const { action } = await inquirer.prompt<{ action: string }>([
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

      // ── modes: guided / semi-auto / auto ───────────────────────────────────
      const result = await runImplementWorkflow(gitx, {
        task,
        mode,
        dryRun,
        jiraTicketKey,

        onAnalysis: async (analysis: AiAnalyzeTaskResponse): Promise<boolean> => {
          printAnalysis(analysis);
          if (mode === "guided") {
            const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
              { type: "confirm", name: "proceed", message: "Continue with this analysis?", default: true },
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

        // In guided mode show each step's diffs and ask before applying
        onStepDiff: mode === "guided"
          ? async (stepTitle: string, diffs: Array<{ path: string; unifiedDiff: string }>): Promise<boolean> => {
              logger.info(`\n📝 Diffs for: ${stepTitle}`);
              for (const d of diffs) {
                logger.info(`\n   📄 ${d.path}`);
                const lines = d.unifiedDiff.split("\n");
                const preview = lines.slice(0, 25).join("\n");
                logger.info(preview);
                if (lines.length > 25) logger.info(`   … (${lines.length - 25} more lines)`);
              }
              const { apply } = await inquirer.prompt<{ apply: boolean }>([
                { type: "confirm", name: "apply", message: "Apply this step?", default: true },
              ]);
              return apply;
            }
          : undefined,
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
      if (result.pr) logger.success(`PR:      ${result.pr.url}`);

      if (result.failedSteps.length > 0) {
        logger.warn(`\n⚠️  Some steps failed to apply:`);
        for (const f of result.failedSteps) logger.warn(`  • ${f.stepId}: ${f.error}`);
      }

      // ── Jira post-PR actions ───────────────────────────────────────────────
      if (jiraTicketKey && gitx.config.jira && result.pr) {
        if (options.jiraComment) {
          const commentSpinner = ora(`Adding comment to ${jiraTicketKey}…`).start();
          try {
            await addJiraComment(
              jiraTicketKey,
              `🤖 gitx created a PR for this ticket:\n${result.pr.url}\n\nBranch: ${result.branchName}`,
              gitx.config.jira
            );
            commentSpinner.succeed(`Comment added to ${jiraTicketKey}`);
          } catch (err: unknown) {
            commentSpinner.warn(`Could not add Jira comment: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (options.jiraTransition) {
          const transSpinner = ora(`Transitioning ${jiraTicketKey} → "${options.jiraTransition}"…`).start();
          try {
            await transitionJiraTicket(jiraTicketKey, options.jiraTransition, gitx.config.jira);
            transSpinner.succeed(`${jiraTicketKey} is now "${options.jiraTransition}"`);
          } catch (err: unknown) {
            transSpinner.warn(`Transition failed: ${err instanceof Error ? err.message : String(err)}`);
          }
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
