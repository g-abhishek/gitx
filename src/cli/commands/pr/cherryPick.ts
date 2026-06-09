/**
 * gitx pr cherry-pick <number>
 *
 * Fetch all commits from a PR and cherry-pick them into the current branch.
 *
 * Use this when you want to pull someone else's PR work (or a PR targeting
 * a different branch) directly onto your own branch — without merging or
 * waiting for the PR to land.
 *
 * Flow:
 *   1. Fetch PR metadata → get head branch + base branch
 *   2. git fetch origin <head>  — ensure commits exist locally
 *   3. List commits between base and head (oldest → newest)
 *   4. Show commits + ask for confirmation (skipped with --no-confirm)
 *   5. Cherry-pick each commit with -x flag (records source SHA)
 *   6. On conflict → AI attempts resolution; unresolvable ones pause for manual fix
 *
 * Usage:
 *   gitx pr cherry-pick 42              # cherry-pick all commits of PR #42
 *   gitx pr cherry-pick 42 --dry-run    # list commits without applying
 *   gitx pr cherry-pick 42 --no-confirm # skip confirmation prompt
 */

import type { Command } from "commander";
import ora from "ora";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { confirm } from "@inquirer/prompts";
import { logger } from "../../../logger/logger.js";
import { isInsideGitRepo } from "../../../utils/git.js";
import { getCurrentBranch } from "../../../utils/gitOps.js";
import { GitxError } from "../../../utils/errors.js";
import { Gitx } from "../../../core/gitx.js";
import { createProvider } from "../../../providers/factory.js";

const execFileAsync = promisify(execFile);

// ─── Git helper ───────────────────────────────────────────────────────────────

async function git(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync("git", args, { cwd });
    return { stdout: result.stdout.trim(), stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout?.trim() ?? "",
      stderr: e.stderr?.trim() ?? "",
      exitCode: e.code ?? 1,
    };
  }
}

// ─── Conflict detection ───────────────────────────────────────────────────────

async function getConflictingFiles(cwd: string): Promise<string[]> {
  const { stdout } = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

// ─── AI conflict resolution ───────────────────────────────────────────────────

async function resolveConflictsWithAi(
  conflictFiles: string[],
  cwd: string,
  gitx: Gitx
): Promise<{ resolved: string[]; needsManual: string[] }> {
  const resolved: string[] = [];
  const needsManual: string[] = [];

  for (const filePath of conflictFiles) {
    const absPath = resolvePath(cwd, filePath);
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      needsManual.push(filePath);
      continue;
    }

    if (!content.includes("<<<<<<<")) {
      needsManual.push(filePath);
      continue;
    }

    const spinner = ora(`  🤖 AI resolving: ${filePath}`).start();
    try {
      const result = await gitx.ai.resolveConflict(filePath, content);

      if (result.confidence === "high") {
        await writeFile(absPath, result.resolved, "utf8");
        spinner.succeed(`  ✅ Auto-resolved: ${filePath} — ${result.explanation}`);
        resolved.push(filePath);
      } else {
        spinner.warn(`  ⚠️  Low confidence: ${filePath} — ${result.explanation}`);
        logger.info(`\n  AI proposed resolution (low confidence). Preview:\n`);
        const preview = result.resolved.split("\n").slice(0, 30).join("\n");
        logger.info(preview);
        if (result.resolved.split("\n").length > 30) {
          logger.info(`  … (${result.resolved.split("\n").length - 30} more lines)`);
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
      spinner.fail(`  ❌ AI resolution failed for: ${filePath}`);
      needsManual.push(filePath);
    }
  }

  return { resolved, needsManual };
}

// ─── Cherry-pick a list of commits ───────────────────────────────────────────

async function cherryPickCommits(
  commits: Array<{ sha: string; subject: string }>,
  cwd: string,
  gitx: Gitx,
  aiAvailable: boolean
): Promise<{ status: "success" | "paused"; remainingIndex: number }> {
  for (let i = 0; i < commits.length; i++) {
    const { sha, subject } = commits[i]!;
    const shortSha = sha.slice(0, 7);

    logger.info(`\n  🍒 [${i + 1}/${commits.length}] ${shortSha} — ${subject}`);

    // -x appends "(cherry picked from commit <sha>)" to the commit message
    const result = await git(["cherry-pick", "-x", sha], cwd);

    if (result.exitCode === 0) {
      logger.success(`     ✓ Applied cleanly`);
      continue;
    }

    // Cherry-pick failed — check for conflicts
    const conflictFiles = await getConflictingFiles(cwd);

    if (conflictFiles.length === 0) {
      // Empty or already-applied commit
      logger.warn(`     ⚠️  Skipping (empty or already applied): ${shortSha}`);
      await git(["cherry-pick", "--skip"], cwd);
      continue;
    }

    logger.warn(`\n  ⚡ Conflicts in ${conflictFiles.length} file(s):`);
    conflictFiles.forEach((f) => logger.info(`     • ${f}`));

    if (!aiAvailable) {
      // No AI — print manual instructions and pause
      logger.error(`\n  ⛔ Manual conflict resolution needed:`);
      conflictFiles.forEach((f) => logger.warn(`     • ${f}`));
      logger.info(`\n  Steps to resolve:`);
      logger.info(`  1. Fix the conflict markers (<<<<, ====, >>>>) in each file`);
      logger.info(`  2. Stage resolved files:  git add <file>`);
      logger.info(`  3. Continue:              git cherry-pick --continue`);
      logger.info(`  4. Or abort:              git cherry-pick --abort`);
      return { status: "paused", remainingIndex: i };
    }

    const { resolved, needsManual } = await resolveConflictsWithAi(conflictFiles, cwd, gitx);

    if (needsManual.length > 0) {
      // Stage auto-resolved files first
      if (resolved.length > 0) {
        await git(["add", ...resolved], cwd);
        logger.info(`\n  ✅ Auto-resolved ${resolved.length} file(s) — staged.`);
      }

      logger.warn(`\n  ⛔ ${needsManual.length} file(s) need manual resolution:`);
      needsManual.forEach((f) => logger.warn(`     • ${f}`));
      logger.info(`\n  Steps to finish:`);
      logger.info(`  1. Fix the conflict markers (<<<<, ====, >>>>) in each file above`);
      logger.info(`  2. Stage resolved files:  git add <file>`);
      logger.info(`  3. Continue:              git cherry-pick --continue`);
      logger.info(`  4. Resume remaining:      gitx pr cherry-pick ${commits.slice(i + 1).map((c) => c.sha.slice(0, 7)).join(", ")}`);
      logger.info(`     Or abort:              git cherry-pick --abort`);
      return { status: "paused", remainingIndex: i };
    }

    // All conflicts resolved — stage and continue
    await git(["add", ...resolved], cwd);
    const continueResult = await git(["cherry-pick", "--continue", "--no-edit"], cwd);

    if (continueResult.exitCode !== 0) {
      logger.error(`  ❌ Could not continue cherry-pick: ${continueResult.stderr}`);
      return { status: "paused", remainingIndex: i };
    }

    logger.success(`     ✅ Conflict resolved and applied`);
  }

  return { status: "success", remainingIndex: -1 };
}

// ─── Register command ─────────────────────────────────────────────────────────

export function registerPrCherryPickCommand(pr: Command): void {
  pr
    .command("cherry-pick")
    .description("🍒 Cherry-pick all commits from a PR into the current branch")
    .argument("<number>", "PR number whose commits to cherry-pick")
    .option("--dry-run", "List the commits that would be cherry-picked without applying them")
    .option("--no-confirm", "Skip the confirmation prompt")
    .action(async (
      prArg: string,
      opts: { dryRun?: boolean; confirm: boolean }
    ) => {
      const cwd = process.cwd();

      if (!(await isInsideGitRepo(cwd))) {
        throw new GitxError("Not inside a git repository. cd into your project folder first.", { exitCode: 2 });
      }

      const prNumber = parseInt(prArg, 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        throw new GitxError(`Invalid PR number: "${prArg}"`, { exitCode: 2 });
      }

      const gitx = await Gitx.fromCwd(cwd);

      // ── Fetch PR metadata ────────────────────────────────────────────────────
      let ctx;
      try {
        ctx = await gitx.getRepoContext();
      } catch (err: unknown) {
        throw new GitxError(
          `Could not determine repo context: ${err instanceof Error ? err.message : String(err)}`,
          { exitCode: 2 }
        );
      }

      const provider = createProvider(ctx);

      const prSpinner = ora(`Fetching PR #${prNumber}…`).start();
      let pr;
      try {
        pr = await provider.getPR(ctx.repoSlug, prNumber);
        prSpinner.succeed(`PR #${prNumber}: "${pr.title}" (${pr.head} → ${pr.base})`);
      } catch (err: unknown) {
        prSpinner.fail(`Could not fetch PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      // ── Guard: don't cherry-pick onto the same branch ────────────────────────
      const currentBranch = await getCurrentBranch(cwd);
      if (currentBranch === pr.head) {
        logger.error(`❌ You are already on the PR source branch "${pr.head}". Nothing to cherry-pick.`);
        process.exitCode = 1;
        return;
      }

      // ── Collect commits from the PR ──────────────────────────────────────────
      //
      // Same 3-strategy cascade as `gitx pr port`:
      //   1. git log origin/<base>..origin/<head>  — fastest, works for open PRs
      //   2. Provider git ref (refs/pull/<id>/head or refs/merge-requests/<id>/head)
      //   3. provider.getPRCommits() REST API  — always works for merged PRs

      let commits: Array<{ sha: string; subject: string }> = [];

      const fetchSpinner = ora(`Fetching commits for PR #${prNumber}…`).start();

      // Strategy 1: source branch still alive
      const branchFetch = await git(["fetch", "origin", pr.head], cwd);
      if (branchFetch.exitCode === 0) {
        const logResult = await git(
          ["log", "--format=%H %s", `origin/${pr.base}..origin/${pr.head}`],
          cwd
        );
        if (logResult.stdout.trim()) {
          commits = logResult.stdout
            .split("\n").map((l) => l.trim()).filter(Boolean)
            .map((line) => {
              const idx = line.indexOf(" ");
              return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
            })
            .reverse();
          fetchSpinner.succeed(`Fetched ${commits.length} commit(s) from origin/${pr.head}`);
        }
      }

      // Strategy 2: provider git ref (for deleted branches)
      if (commits.length === 0) {
        const prRef = ctx.provider === "gitlab"
          ? `refs/merge-requests/${prNumber}/head`
          : `refs/pull/${prNumber}/head`;

        const refFetch = await git(
          ["fetch", "origin", `${prRef}:refs/remotes/origin/pr/${prNumber}`],
          cwd
        );
        if (refFetch.exitCode === 0) {
          const logResult = await git(
            ["log", "--format=%H %s", `origin/${pr.base}..origin/pr/${prNumber}`],
            cwd
          );
          if (logResult.stdout.trim()) {
            commits = logResult.stdout
              .split("\n").map((l) => l.trim()).filter(Boolean)
              .map((line) => {
                const idx = line.indexOf(" ");
                return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
              })
              .reverse();
            fetchSpinner.succeed(`Fetched ${commits.length} commit(s) via PR ref`);
          }
        }
      }

      // Strategy 3: provider REST API — always works for merged PRs
      if (commits.length === 0) {
        fetchSpinner.text = `Source branch deleted — fetching commits via provider API…`;
        try {
          const apiCommits = await provider.getPRCommits(ctx.repoSlug, prNumber);
          if (apiCommits.length > 0) {
            await git(["fetch", "origin"], cwd);
            commits = apiCommits;
            fetchSpinner.succeed(`Fetched ${commits.length} commit(s) from provider API (branch was deleted)`);
          }
        } catch (apiErr) {
          fetchSpinner.fail(`Could not retrieve commits for PR #${prNumber}: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`);
          process.exitCode = 1;
          return;
        }
      }

      if (commits.length === 0) {
        fetchSpinner.fail(`No commits found for PR #${prNumber}.`);
        process.exitCode = 1;
        return;
      }

      // ── Show commit list ──────────────────────────────────────────────────────
      logger.info(`\n📋 ${commits.length} commit(s) from PR #${prNumber} to cherry-pick into ${currentBranch}:\n`);
      for (const { sha, subject } of commits) {
        logger.info(`   + ${sha.slice(0, 7)} — ${subject}`);
      }

      if (opts.dryRun) {
        logger.info(`\n⏸  Dry run — no commits applied.`);
        return;
      }

      // ── Confirmation ──────────────────────────────────────────────────────────
      if (opts.confirm !== false) {
        let proceed = false;
        try {
          proceed = await confirm({
            message: `Cherry-pick ${commits.length} commit(s) onto "${currentBranch}"?`,
            default: true,
          });
        } catch {
          proceed = false;
        }
        if (!proceed) {
          logger.info("Cancelled.");
          return;
        }
      }

      // ── Cherry-pick ───────────────────────────────────────────────────────────
      logger.info(`\n🍒 Cherry-picking ${commits.length} commit(s)…`);

      const aiAvailable = await Gitx.isAiAvailable(gitx.config);
      if (!aiAvailable) {
        logger.warn("⚠️  No AI configured — conflicts will require manual resolution.");
      }

      const result = await cherryPickCommits(commits, cwd, gitx, aiAvailable);

      if (result.status === "paused") {
        logger.warn(`\n⚠️  Cherry-pick paused at commit ${commits[result.remainingIndex]?.sha.slice(0, 7) ?? "?"}. Resolve conflicts manually then run:`);
        logger.info(`   git cherry-pick --continue`);
        process.exitCode = 1;
        return;
      }

      logger.success(`\n✅ All ${commits.length} commit(s) from PR #${prNumber} cherry-picked into "${currentBranch}".`);
      logger.info(`   Review the changes, then push when ready: gitx push`);
    });
}
