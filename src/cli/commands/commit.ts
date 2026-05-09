/**
 * gitx commit
 *
 * AI-powered commit: detects what changed, generates a meaningful
 * conventional-commit message, commits, and optionally pushes.
 *
 * Usage:
 *   gitx commit                  # AI generates message, prompts to confirm
 *   gitx commit -m "fix: typo"   # use custom message, skip AI
 *   gitx commit --push           # commit + push in one step
 *   gitx commit --no-push        # commit only (default)
 *   gitx commit --dry-run        # preview message, do not commit
 */

import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../logger/logger.js";
import { Gitx } from "../../core/gitx.js";
import {
  stageAll,
  hasStagedChanges,
  isWorkingTreeDirty,
  getWorkingDiff,
  getWorkingDiffStat,
  commitChanges,
  pushBranch,
  getCurrentBranch,
} from "../../utils/gitOps.js";
import { isInsideGitRepo } from "../../utils/git.js";
import { GitxError } from "../../utils/errors.js";
import { withLockRetry } from "../../utils/lockFile.js";

export function registerCommitCommand(program: Command): void {
  program
    .command("commit")
    .description("🤖 Stage, AI-generate a commit message, commit, and optionally push")
    .option("-m, --message <msg>", "Use a custom commit message (skips AI generation)")
    .option("--push", "Push to remote after committing")
    .option("--no-push", "Commit only, do not push (default)")
    .option("--dry-run", "Preview the commit message without committing")
    .option("--all", "Stage all changes before committing (default: true)", true)
    .action(async (opts: {
      message?: string;
      push: boolean;
      dryRun?: boolean;
      all: boolean;
    }) => {
      const cwd = process.cwd();

      // ── Guards ──────────────────────────────────────────────────────────
      if (!(await isInsideGitRepo(cwd))) {
        throw new GitxError("Not inside a git repository.", { exitCode: 2 });
      }

      const dirty = await isWorkingTreeDirty(cwd);
      if (!dirty) {
        logger.info("✨ Nothing to commit — working tree is clean.");
        return;
      }

      // ── Stage changes ────────────────────────────────────────────────────
      if (opts.all) {
        const stageSpinner = ora("Staging all changes…").start();
        await withLockRetry(() => stageAll(cwd), cwd);
        stageSpinner.succeed("All changes staged.");
      }

      const staged = await hasStagedChanges(cwd);
      if (!staged) {
        logger.warn("No staged changes found. Use `git add` to stage files, or run without --no-all.");
        return;
      }

      // ── Get diff for AI ──────────────────────────────────────────────────
      // stat = compact file list (always complete, never truncated)
      // diff = full patch (may be large — we truncate later in the AI call)
      const [stat, diff] = await Promise.all([
        getWorkingDiffStat(cwd),
        getWorkingDiff(cwd),
      ]);

      // ── Generate or use custom message ───────────────────────────────────
      let commitMsg: string;

      if (opts.message) {
        commitMsg = opts.message;
        logger.info(`📝 Using provided message: ${commitMsg}`);
      } else {
        const gitx = await Gitx.fromCwd(cwd);

        if (!Gitx.isAiAvailable(gitx.config)) {
          logger.warn("⚠️  No AI provider configured. Run `gitx config` to set one up.");
          logger.warn("   Falling back to manual commit message entry.\n");

          const { manualMsg } = await inquirer.prompt<{ manualMsg: string }>([
            {
              type: "input",
              name: "manualMsg",
              message: "Commit message:",
              validate: (v: string) => v.trim().length > 0 || "Message cannot be empty",
            },
          ]);
          commitMsg = manualMsg.trim();
        } else {
          const aiSpinner = ora("🤖 Generating commit message…").start();
          try {
            // Build AI input: complete file summary first, then detailed patch.
            // The stat ensures the AI sees every changed file even when the
            // full diff is truncated by the 12 000 char safety limit.
            const aiInput = stat
              ? `=== Changed files (complete list) ===\n${stat}\n\n=== Detailed diff ===\n${diff}`
              : diff;
            const result = await gitx.ai.generateCommitMessage(aiInput);

            // Use the AI-generated conventional commit subject + optional body as-is
            commitMsg = result.body
              ? `${result.subject}\n\n${result.body}`
              : result.subject;

            aiSpinner.succeed("Commit message generated.");
          } catch (err) {
            aiSpinner.fail("AI generation failed.");
            logger.warn(`   ${err instanceof Error ? err.message : String(err)}`);
            logger.warn("   Falling back to manual entry.\n");

            const { manualMsg } = await inquirer.prompt<{ manualMsg: string }>([
              {
                type: "input",
                name: "manualMsg",
                message: "Commit message:",
                validate: (v: string) => v.trim().length > 0 || "Message cannot be empty",
              },
            ]);
            commitMsg = manualMsg.trim();
          }
        }
      }

      // ── Show preview and confirm ─────────────────────────────────────────
      logger.info("\n📋 Commit message preview:\n");
      logger.info("─".repeat(60));
      logger.info(commitMsg);
      logger.info("─".repeat(60));

      if (opts.dryRun) {
        logger.info("\n🔍 Dry run — nothing committed.");
        return;
      }

      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
        {
          type: "confirm",
          name: "confirmed",
          message: "Commit with this message?",
          default: true,
        },
      ]);

      if (!confirmed) {
        // Let user edit the message manually
        const { editedMsg } = await inquirer.prompt<{ editedMsg: string }>([
          {
            type: "editor",
            name: "editedMsg",
            message: "Edit commit message:",
            default: commitMsg,
          },
        ]);
        commitMsg = editedMsg.trim();
        if (!commitMsg) {
          logger.warn("Empty message — commit aborted.");
          return;
        }
      }

      // ── Commit ───────────────────────────────────────────────────────────
      const commitSpinner = ora("Committing…").start();
      await withLockRetry(() => commitChanges(commitMsg, cwd), cwd);
      commitSpinner.succeed("Committed ✓");

      // ── Push ─────────────────────────────────────────────────────────────
      if (opts.push) {
        const branch = await getCurrentBranch(cwd);
        const pushSpinner = ora(`Pushing ${branch} to origin…`).start();
        await pushBranch(branch, cwd);
        pushSpinner.succeed(`Pushed to origin/${branch} ✓`);
        logger.success(`\n✅ Done! Changes committed and pushed.`);
      } else {
        logger.success(`\n✅ Done! Run \`gitx commit --push\` or \`git push\` to push.`);
      }
    });
}

