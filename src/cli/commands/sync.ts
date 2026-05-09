/**
 * gitx sync
 *
 * Bring the current branch up to date with its base branch so a PR can be
 * merged cleanly. Uses rebase by default (keeps a linear history).
 *
 * Flow:
 *   1. Detect base branch (same logic as `gitx pr create`)
 *   2. git fetch origin
 *   3. git rebase origin/<base>  (or --merge: git merge origin/<base>)
 *   4a. No conflicts → git push --force-with-lease → "ready to merge"
 *   4b. Conflicts  → list conflicting files, instruct user how to resolve,
 *                    then run `gitx sync --continue` to finish
 *
 * Usage:
 *   gitx sync                  # rebase onto auto-detected base
 *   gitx sync --base main      # rebase onto a specific base
 *   gitx sync --strategy merge # merge base into branch instead of rebase
 *   gitx sync --continue       # after manually resolving conflicts
 *   gitx sync --abort          # abort an in-progress rebase/merge
 */

import type { Command } from "commander";
import ora from "ora";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../../logger/logger.js";
import { getCurrentBranch, detectBaseBranch } from "../../utils/gitOps.js";
import { isInsideGitRepo } from "../../utils/git.js";
import { GitxError } from "../../utils/errors.js";

const execFileAsync = promisify(execFile);

async function git(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, { cwd });
    return { stdout: result.stdout.trim(), stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout?.trim() ?? "",
      stderr: (e.stderr ?? e.message ?? String(err)).trim(),
    };
  }
}

/** Returns list of files that currently have conflict markers. */
async function getConflictingFiles(cwd: string): Promise<string[]> {
  const { stdout } = await git(
    ["diff", "--name-only", "--diff-filter=U"],
    cwd
  );
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Check whether a rebase or merge is currently in progress. */
async function getInProgressOperation(
  cwd: string
): Promise<"rebase" | "merge" | null> {
  const { stdout: gitDir } = await git(["rev-parse", "--git-dir"], cwd);
  const base = gitDir || ".git";

  const { stdout: rebaseDir } = await git(
    ["rev-parse", "--git-path", "rebase-merge"],
    cwd
  );
  const { stdout: rebaseApply } = await git(
    ["rev-parse", "--git-path", "rebase-apply"],
    cwd
  );
  const { stdout: mergeHead } = await git(
    ["rev-parse", "--git-path", "MERGE_HEAD"],
    cwd
  );

  // Check if the paths actually exist on disk
  const { existsSync } = await import("node:fs");
  if (existsSync(rebaseDir) || existsSync(rebaseApply)) return "rebase";
  if (existsSync(mergeHead) || existsSync(`${base}/MERGE_HEAD`)) return "merge";
  return null;
}

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("🔄 Sync current branch with its base to resolve PR merge conflicts")
    .option("--base <branch>", "Base branch to sync with (auto-detected if omitted)")
    .option(
      "--strategy <strategy>",
      "Sync strategy: rebase (default) | merge",
      "rebase"
    )
    .option("--continue", "Continue after manually resolving conflicts")
    .option("--abort", "Abort an in-progress rebase or merge")
    .action(async (opts: {
      base?: string;
      strategy: string;
      continue?: boolean;
      abort?: boolean;
    }) => {
      const cwd = process.cwd();

      if (!(await isInsideGitRepo(cwd))) {
        throw new GitxError("Not inside a git repository.", { exitCode: 2 });
      }

      const strategy = opts.strategy === "merge" ? "merge" : "rebase";

      // ── Handle --abort ─────────────────────────────────────────────────────
      if (opts.abort) {
        const op = await getInProgressOperation(cwd);
        if (!op) {
          logger.info("No rebase or merge in progress.");
          return;
        }
        const abortSpinner = ora(`Aborting ${op}…`).start();
        const { stderr } = await git([op, "--abort"], cwd);
        if (stderr) {
          abortSpinner.fail(`Abort failed: ${stderr}`);
          process.exitCode = 1;
          return;
        }
        abortSpinner.succeed(`${op.charAt(0).toUpperCase() + op.slice(1)} aborted. Branch restored to its previous state.`);
        return;
      }

      // ── Handle --continue ──────────────────────────────────────────────────
      if (opts.continue) {
        const op = await getInProgressOperation(cwd);
        if (!op) {
          logger.info("No rebase or merge in progress — nothing to continue.");
          return;
        }

        // Check if all conflicts are resolved
        const conflicts = await getConflictingFiles(cwd);
        if (conflicts.length > 0) {
          logger.error(`\n❌ There are still unresolved conflicts:\n`);
          for (const f of conflicts) logger.info(`   • ${f}`);
          logger.info(`\n  Fix the conflicts above, then:\n`);
          logger.info(`    git add <file>          # mark each file as resolved`);
          logger.info(`    gitx sync --continue    # resume\n`);
          process.exitCode = 1;
          return;
        }

        // Stage all resolved files and continue
        await git(["add", "-A"], cwd);
        const continueSpinner = ora(`Continuing ${op}…`).start();

        const env = { ...process.env, GIT_EDITOR: "true" }; // skip editor for commit msg
        const { stderr } = await execFileAsync(
          "git",
          [op, "--continue"],
          { cwd, env }
        ).then(
          (r) => ({ stdout: r.stdout, stderr: "" }),
          (e: { stderr?: string; message?: string }) => ({
            stdout: "",
            stderr: (e.stderr ?? e.message ?? "").trim(),
          })
        );

        if (stderr && !stderr.includes("Successfully")) {
          continueSpinner.fail(`Could not continue ${op}: ${stderr}`);
          process.exitCode = 1;
          return;
        }
        continueSpinner.succeed(`${op.charAt(0).toUpperCase() + op.slice(1)} completed ✓`);

        // Push
        await pushAfterSync(cwd);
        return;
      }

      // ── Normal sync flow ───────────────────────────────────────────────────
      const head = await getCurrentBranch(cwd);

      // Resolve base
      let base: string;
      if (opts.base) {
        base = opts.base;
        logger.info(`📌 Base branch (provided): ${base}`);
      } else {
        const detectSpinner = ora("Detecting base branch…").start();
        base = await detectBaseBranch(cwd);
        detectSpinner.succeed(`Base branch: ${base}`);
      }

      if (head === base) {
        logger.info(`✨ Already on the base branch "${base}" — nothing to sync.`);
        return;
      }

      logger.info(`\n🔄 Syncing  ${head}  onto  origin/${base}\n`);

      // Fetch latest
      const fetchSpinner = ora("Fetching latest from origin…").start();
      const { stderr: fetchErr } = await git(["fetch", "origin"], cwd);
      if (fetchErr && !fetchErr.includes("->")) {
        fetchSpinner.fail(`Fetch failed: ${fetchErr}`);
        process.exitCode = 1;
        return;
      }
      fetchSpinner.succeed("Fetched latest.");

      // Check if we're already up to date
      const { stdout: behindCount } = await git(
        ["rev-list", "--count", `HEAD..origin/${base}`],
        cwd
      );
      if (behindCount === "0") {
        logger.success(`✅ "${head}" is already up to date with origin/${base}. Ready to merge!`);
        return;
      }

      // Run rebase or merge
      const syncSpinner = ora(
        strategy === "rebase"
          ? `Rebasing ${head} onto origin/${base}…`
          : `Merging origin/${base} into ${head}…`
      ).start();

      const syncArgs =
        strategy === "rebase"
          ? ["rebase", `origin/${base}`]
          : ["merge", `origin/${base}`, "--no-edit"];

      const { stderr: syncErr } = await git(syncArgs, cwd);

      // Detect conflict
      const conflicts = await getConflictingFiles(cwd);
      if (conflicts.length > 0) {
        syncSpinner.fail("Conflicts detected — manual resolution required.");

        logger.error(`\n⚠️  Merge conflicts in ${conflicts.length} file(s):\n`);
        for (const f of conflicts) logger.info(`   • ${f}`);

        logger.info(`\n  Steps to resolve:\n`);
        logger.info(`  1. Open each file and fix the conflict markers (<<<<, ====, >>>>)`);
        logger.info(`  2. Mark resolved:   git add <file>`);
        logger.info(`  3. Finish sync:     gitx sync --continue`);
        logger.info(`  4. Retry merge:     gitx pr merge <number>\n`);
        logger.info(`  To give up and go back: gitx sync --abort\n`);
        process.exitCode = 1;
        return;
      }

      if (syncErr && !syncErr.toLowerCase().includes("successfully")) {
        syncSpinner.fail(`Sync failed: ${syncErr}`);
        process.exitCode = 1;
        return;
      }

      syncSpinner.succeed(
        strategy === "rebase"
          ? `Rebased ${head} onto origin/${base} ✓`
          : `Merged origin/${base} into ${head} ✓`
      );

      // Push
      await pushAfterSync(cwd);
    });
}

async function pushAfterSync(cwd: string): Promise<void> {
  const pushSpinner = ora("Pushing (force-with-lease)…").start();
  // Rebase rewrites history, so force push is required.
  // --force-with-lease is safe: it refuses to push if someone else pushed in the meantime.
  const { stderr } = await git(["push", "--force-with-lease"], cwd);
  if (stderr && stderr.includes("error")) {
    pushSpinner.fail(`Push failed: ${stderr}`);
    logger.info(`  Try: git push --force-with-lease`);
    process.exitCode = 1;
    return;
  }
  pushSpinner.succeed("Pushed ✓");
  logger.success(`\n✅ Branch is now up to date. Run \`gitx pr merge <number>\` to merge.\n`);
}
