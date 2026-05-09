/**
 * gitx pr merge <number>
 *
 * Merge a pull request via the provider API.
 *
 * Flow:
 *   1. Fetch PR details and show a summary
 *   2. Guard: PR must be open (not already merged / closed)
 *   3. Confirm (or skip with --force)
 *   4. Merge via API using the chosen strategy
 *   5. Optionally delete the source branch (local + remote)
 *   6. Optionally checkout the base branch and pull
 *
 * Usage:
 *   gitx pr merge 42                    # squash-merge (default), asks to confirm
 *   gitx pr merge 42 --method merge     # regular merge commit
 *   gitx pr merge 42 --method rebase    # rebase and merge
 *   gitx pr merge 42 --delete-branch    # delete source branch after merging
 *   gitx pr merge 42 --force            # skip confirmation prompt
 */

import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { createProvider } from "../../../providers/factory.js";
import type { MergePrOptions } from "../../../providers/base.js";
import { GitxError } from "../../../utils/errors.js";
import { getCurrentBranch } from "../../../utils/gitOps.js";

const execFileAsync = promisify(execFile);

async function gitLocal(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

export function registerPrMergeCommand(pr: Command): void {
  pr.command("merge <number>")
    .description("🔀 Merge a pull request")
    .option(
      "--method <method>",
      "Merge strategy: squash | merge | rebase (default: squash)",
      "squash"
    )
    .option("--delete-branch", "Delete the source branch after merging", false)
    .option("-f, --force", "Skip confirmation prompt", false)
    .action(async (numberArg: string, opts: {
      method: string;
      deleteBranch: boolean;
      force: boolean;
    }) => {
      const prNumber = parseInt(numberArg, 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        throw new GitxError(`Invalid PR number: "${numberArg}"`, { exitCode: 2 });
      }

      const validMethods = ["squash", "merge", "rebase"];
      if (!validMethods.includes(opts.method)) {
        throw new GitxError(
          `Invalid merge method "${opts.method}". Choose: squash | merge | rebase`,
          { exitCode: 2 }
        );
      }
      const method = opts.method as MergePrOptions["method"];

      const cwd = process.cwd();
      const gitx = await Gitx.fromCwd(cwd);
      const ctx = await gitx.getRepoContext();
      const provider = createProvider(ctx);

      // ── Fetch PR details ───────────────────────────────────────────────────
      const fetchSpinner = ora(`Fetching PR #${prNumber}…`).start();
      let pr_: Awaited<ReturnType<typeof provider.getPR>>;
      try {
        pr_ = await provider.getPR(ctx.repoSlug, prNumber);
        fetchSpinner.stop();
      } catch (err) {
        fetchSpinner.fail();
        throw err;
      }

      // ── Guards ─────────────────────────────────────────────────────────────
      if (pr_.state === "merged") {
        logger.warn(`PR #${prNumber} is already merged.`);
        logger.info(`   ${pr_.url}`);
        return;
      }
      if (pr_.state === "closed") {
        throw new GitxError(
          `PR #${prNumber} is closed and cannot be merged. Reopen it first.`,
          { exitCode: 1 }
        );
      }

      // ── Show PR summary ────────────────────────────────────────────────────
      const methodLabel: Record<MergePrOptions["method"], string> = {
        squash: "Squash and merge",
        merge:  "Create a merge commit",
        rebase: "Rebase and merge",
      };

      logger.info(`\n  #${pr_.number}  ${pr_.title}`);
      logger.info(`  Branch:  ${pr_.head} → ${pr_.base}`);
      logger.info(`  Author:  ${pr_.author}`);
      logger.info(`  Method:  ${methodLabel[method]}`);
      logger.info(`  URL:     ${pr_.url}\n`);

      // ── Confirm ────────────────────────────────────────────────────────────
      if (!opts.force) {
        const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
          {
            type: "confirm",
            name: "confirmed",
            message: `Merge PR #${prNumber}${opts.deleteBranch ? " and delete source branch" : ""}?`,
            default: true,
          },
        ]);
        if (!confirmed) {
          logger.info("Aborted — PR not merged.");
          return;
        }
      }

      // ── Merge via API ──────────────────────────────────────────────────────
      const mergeSpinner = ora(`Merging PR #${prNumber} (${method})…`).start();
      try {
        await provider.mergePR(ctx.repoSlug, prNumber, {
          method,
          commitTitle: pr_.title,
          deleteSourceBranch: opts.deleteBranch,
        });
      } catch (err) {
        mergeSpinner.fail("Merge failed.");
        const msg = err instanceof Error ? err.message : String(err);

        // GitHub 405 / GitLab 405/406 = merge conflicts or branch not mergeable
        const isConflict =
          msg.includes("merge conflict") ||
          msg.includes("405") ||
          msg.includes("not mergeable") ||
          msg.toLowerCase().includes("conflict");

        if (isConflict) {
          logger.error(`\n❌ PR #${prNumber} has merge conflicts.\n`);
          logger.info(`  The branch "${pr_.head}" is out of sync with "${pr_.base}".`);
          logger.info(`  Sync and resolve conflicts, then retry:\n`);
          logger.info(`    gitx sync              ← rebase onto ${pr_.base} and push`);
          logger.info(`    gitx pr merge ${prNumber}    ← retry after sync\n`);
          logger.info(`  Or resolve manually:`);
          logger.info(`    git fetch origin`);
          logger.info(`    git rebase origin/${pr_.base}`);
          logger.info(`    # fix conflicts in editor, then:`);
          logger.info(`    git add . && git rebase --continue`);
          logger.info(`    git push --force-with-lease`);
          process.exitCode = 1;
          return;
        }

        throw err; // re-throw non-conflict errors
      }
      mergeSpinner.succeed(`PR #${prNumber} merged ✓`);

      // ── Delete source branch locally if requested ──────────────────────────
      if (opts.deleteBranch) {
        const currentBranch = await getCurrentBranch(cwd);

        // If we're ON the merged branch, switch to base first
        if (currentBranch === pr_.head) {
          const switchSpinner = ora(`Switching to ${pr_.base}…`).start();
          try {
            await gitLocal(["checkout", pr_.base], cwd);
            await gitLocal(["pull", "--ff-only"], cwd);
            switchSpinner.succeed(`Switched to ${pr_.base} and pulled latest.`);
          } catch {
            switchSpinner.fail(`Could not switch to ${pr_.base} — switch manually before deleting.`);
          }
        }

        // Delete local branch
        try {
          await gitLocal(["branch", "-d", pr_.head], cwd);
          logger.success(`   Deleted local branch: ${pr_.head}`);
        } catch {
          // -d refuses to delete if not fully merged locally; use -D
          try {
            await gitLocal(["branch", "-D", pr_.head], cwd);
            logger.success(`   Force-deleted local branch: ${pr_.head}`);
          } catch {
            logger.warn(`   Could not delete local branch "${pr_.head}" — delete it manually.`);
          }
        }

        // Delete remote branch
        try {
          await gitLocal(["push", "origin", "--delete", pr_.head], cwd);
          logger.success(`   Deleted remote branch: origin/${pr_.head}`);
        } catch {
          logger.warn(`   Could not delete remote branch "origin/${pr_.head}" — it may already be gone.`);
        }
      } else {
        // Even without --delete-branch, offer to pull base if we're on it
        const currentBranch = await getCurrentBranch(cwd);
        if (currentBranch === pr_.base) {
          try {
            await gitLocal(["pull", "--ff-only"], cwd);
            logger.success(`   Pulled latest ${pr_.base}.`);
          } catch {
            // Non-fatal
          }
        }
      }

      logger.success(`\n✅ Done! ${pr_.url}`);
    });
}
