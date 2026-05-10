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
import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { confirm, select } from "@inquirer/prompts";
import { logger } from "../../logger/logger.js";
import { getCurrentBranch, detectBaseBranch } from "../../utils/gitOps.js";
import { isInsideGitRepo } from "../../utils/git.js";
import { GitxError } from "../../utils/errors.js";
import { Gitx } from "../../core/gitx.js";
import { createProvider } from "../../providers/factory.js";
import { runAddressWorkflow, filterUnresolvedInlineComments } from "../../workflows/prAddress.js";

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
    .description("🔄 Sync current branch with its base branch (merge by default, or --strategy rebase)")
    .option("--base <branch>", "Base branch to sync with (auto-detected if omitted)")
    .option(
      "--strategy <strategy>",
      "Sync strategy: merge (default) | rebase",
      "merge"
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
        throw new GitxError("Not inside a git repository. cd into your project folder first.", { exitCode: 2 });
      }

      const strategy = opts.strategy === "rebase" ? "rebase" : "merge";

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

        // Rebase rewrites history; merge does not
        await pushAfterSync(cwd, op === "rebase");
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

      // ── Check for unresolved PR review comments BEFORE syncing ────────────
      // If the current branch has an open PR with unresolved inline comments,
      // offer to resolve them now. Fixes are committed onto the branch; the
      // sync then rebases/merges and pushes everything together.
      await checkAndOfferAddressComments(cwd, head);

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

      // Detect conflict — try AI resolution first
      const conflicts = await getConflictingFiles(cwd);
      if (conflicts.length > 0) {
        syncSpinner.fail(`Conflicts detected in ${conflicts.length} file(s) — attempting AI resolution…`);

        // Try to load an AI client
        let gitx: Gitx | null = null;
        try {
          gitx = await Gitx.fromCwd(cwd);
        } catch {
          // No AI available; fall through to manual instructions
        }

        if (gitx && Gitx.isAiAvailable(gitx.config)) {
          const resolved: string[] = [];
          const needsManual: string[] = [];

          for (const filePath of conflicts) {
            const absPath = resolvePath(cwd, filePath);
            let content: string;
            try {
              content = await readFile(absPath, "utf8");
            } catch {
              needsManual.push(filePath);
              continue;
            }

            // Skip binary files (no conflict markers)
            if (!content.includes("<<<<<<<")) {
              needsManual.push(filePath);
              continue;
            }

            const resolveSpinner = ora(`  🤖 AI resolving: ${filePath}`).start();
            try {
              const result = await gitx.ai.resolveConflict(filePath, content);

              if (result.confidence === "high") {
                await writeFile(absPath, result.resolved, "utf8");
                resolveSpinner.succeed(`  ✅ Auto-resolved: ${filePath} — ${result.explanation}`);
                resolved.push(filePath);
              } else {
                resolveSpinner.warn(`  ⚠️  Low confidence: ${filePath} — ${result.explanation}`);
                logger.info(`\n  AI proposed resolution (low confidence). Preview:\n`);
                // Show first 40 lines of the resolved content as a preview
                const preview = result.resolved.split("\n").slice(0, 40).join("\n");
                logger.info(preview);
                if (result.resolved.split("\n").length > 40) {
                  logger.info(`  … (${result.resolved.split("\n").length - 40} more lines)`);
                }
                logger.info("");

                let apply = false;
                try {
                  apply = await confirm({
                    message: `Apply AI resolution for ${filePath}?`,
                    default: true,
                  });
                } catch {
                  apply = false;
                }

                if (apply) {
                  await writeFile(absPath, result.resolved, "utf8");
                  logger.success(`  ✅ Applied: ${filePath}`);
                  resolved.push(filePath);
                } else {
                  logger.info(`  ⏭️  Skipped: ${filePath} — resolve manually`);
                  needsManual.push(filePath);
                }
              }
            } catch {
              resolveSpinner.fail(`  ❌ AI resolution failed for: ${filePath}`);
              needsManual.push(filePath);
            }
          }

          if (needsManual.length > 0) {
            logger.error(`\n⚠️  ${needsManual.length} file(s) still need manual resolution:\n`);
            for (const f of needsManual) logger.info(`   • ${f}`);
            logger.info(`\n  Steps to finish:\n`);
            logger.info(`  1. Open each file and fix the conflict markers (<<<<, ====, >>>>)`);
            logger.info(`  2. Mark resolved:   git add <file>`);
            logger.info(`  3. Finish sync:     gitx sync --continue`);
            logger.info(`  4. Retry merge:     gitx pr merge <number>\n`);
            logger.info(`  To give up and go back: gitx sync --abort\n`);
            process.exitCode = 1;
            return;
          }

          // All resolved — stage and continue
          if (resolved.length > 0) {
            logger.success(`\n✅ AI resolved all ${resolved.length} conflict(s). Staging and continuing…\n`);
            await git(["add", "-A"], cwd);

            const env = { ...process.env, GIT_EDITOR: "true" };
            const { stderr: contErr } = await execFileAsync(
              "git",
              [strategy === "rebase" ? "rebase" : "merge", "--continue"],
              { cwd, env }
            ).then(
              (r) => ({ stdout: r.stdout, stderr: "" }),
              (e: { stderr?: string; message?: string }) => ({
                stdout: "",
                stderr: (e.stderr ?? e.message ?? "").trim(),
              })
            );

            if (contErr && !contErr.toLowerCase().includes("successfully")) {
              logger.error(`Could not continue ${strategy}: ${contErr}`);
              process.exitCode = 1;
              return;
            }
          }
        } else {
          // No AI — fall back to manual instructions
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

      // Rebase rewrites history → force-with-lease; merge → plain push
      await pushAfterSync(cwd, strategy === "rebase");
    });
}

/**
 * Before syncing, look up any open PR for the current branch.
 * If it has unresolved inline review comments, ask the user:
 *   - "Resolve comments first, then sync"  → address + commit, sync continues
 *   - "Sync normally"                       → proceed immediately
 *
 * Fixes are committed using "commit-no-push" mode so the sync rebase/merge
 * picks them up and pushes everything together in a single push.
 */
async function checkAndOfferAddressComments(cwd: string, currentBranch: string): Promise<void> {
  let gitx: Gitx | null = null;
  try {
    gitx = await Gitx.fromCwd(cwd);
    if (!Gitx.isAiAvailable(gitx.config)) return;
  } catch {
    return; // no gitx config — skip silently
  }

  let prNumber: number | null = null;
  let unresolvedCount = 0;

  try {
    const ctx = await gitx.getRepoContext();
    const provider = createProvider(ctx);

    // Find the open PR for the current branch
    const prs = await provider.listPRs(ctx.repoSlug);
    const openPr = prs.find((p) => p.head === currentBranch && p.state === "open");
    if (!openPr) return;

    prNumber = openPr.number;

    // Use the shared helper: root inline comments with no "✅ Addressed" reply yet
    const allComments = await provider.getPRComments(ctx.repoSlug, prNumber);
    unresolvedCount = filterUnresolvedInlineComments(allComments).length;

    if (unresolvedCount === 0) return;
  } catch {
    return; // provider error — don't block the sync
  }

  // ── Surface the choice ──────────────────────────────────────────────────────
  logger.info(`\n💬 PR #${prNumber} has ${unresolvedCount} unresolved review comment(s).\n`);

  let choice: string;
  try {
    choice = await select({
      message: "How would you like to proceed?",
      choices: [
        {
          name: `Resolve comments first, then sync  (AI generates fixes → you approve → commit → sync)`,
          value: "resolve",
        },
        {
          name: `Sync normally  (skip comment resolution, proceed with merge)`,
          value: "skip",
        },
      ],
    });
  } catch {
    return; // Ctrl-C → skip
  }

  if (choice === "skip") {
    logger.info("⏭️  Skipping comment resolution — proceeding with sync.\n");
    return;
  }

  // ── Resolve comments (commit but don't push — sync handles the push) ───────
  logger.info(`\n🔧 Resolving ${unresolvedCount} review comment(s) on PR #${prNumber}…\n`);
  try {
    const result = await runAddressWorkflow(gitx!, prNumber, { mode: "commit-no-push" });
    const applied = result.addressed.filter((a) => a.applied).length;
    const skipped = result.addressed.filter((a) => a.skipped).length;

    if (applied > 0) {
      logger.success(`✅ ${applied} fix(es) committed.${skipped > 0 ? `  (${skipped} skipped)` : ""}`);
      logger.info("   Sync will rebase these commits and push everything together.\n");
    } else {
      logger.info("   No fixes applied — continuing with normal sync.\n");
    }
  } catch (err) {
    logger.warn(`⚠️  Comment resolution error: ${(err as Error).message}\n   Continuing with sync.\n`);
  }
}

async function pushAfterSync(cwd: string, forceWithLease = false): Promise<void> {
  // Rebase rewrites history → requires --force-with-lease.
  // Merge does not rewrite history → plain push is fine.
  const pushArgs = forceWithLease
    ? ["push", "--force-with-lease"]
    : ["push"];

  const label = forceWithLease ? "Pushing (force-with-lease)…" : "Pushing…";
  const pushSpinner = ora(label).start();
  const { stderr } = await git(pushArgs, cwd);
  if (stderr && stderr.includes("error")) {
    pushSpinner.fail(`Push failed: ${stderr}`);
    const hint = forceWithLease ? "git push --force-with-lease" : "git push";
    logger.info(`  Try: ${hint}`);
    process.exitCode = 1;
    return;
  }
  pushSpinner.succeed("Pushed ✓");
  logger.success(`\n✅ Branch is now up to date. Run \`gitx pr merge <number>\` to merge.\n`);
}
