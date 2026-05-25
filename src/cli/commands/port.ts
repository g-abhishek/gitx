/**
 * gitx port <target1> [target2...]
 *
 * Cherry-pick all commits from the current branch onto one or more target
 * branches, with AI-assisted conflict resolution, then push and open PRs.
 *
 * Smart incremental detection via `git cherry`:
 *   - First run  → creates port/<source>-to-<target>, ports all commits
 *   - Re-run     → detects which commits are NEW since the last port, ports only those
 *   - Up to date → tells you nothing to do
 *
 * Flow (per target branch):
 *   1. Detect base branch → collect commits on current branch (base..HEAD)
 *   2. If port branch exists → run `git cherry` to find unported commits only
 *   3. Create (or checkout) port/<source>-to-<target> from origin/<target>
 *   4. Cherry-pick commits oldest→newest with -x flag (records source SHA)
 *   5. On conflict → AI resolves → stage → cherry-pick --continue
 *   6. On unresolvable → pause, print manual instructions, `gitx port --continue`
 *   7. Push → create PR
 *
 * Usage:
 *   gitx port release/v2                        # port to one branch
 *   gitx port release/v2 hotfix/v1              # port to multiple branches
 *   gitx port release/v2 --base develop         # override base branch
 *   gitx port release/v2 --no-pr                # skip PR creation
 *   gitx port release/v2 --draft                # create draft PRs
 *   gitx port --continue                        # after manually resolving conflicts
 *   gitx port --abort                           # abort a stuck cherry-pick
 */

import type { Command } from "commander";
import ora from "ora";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, writeFile as fsWriteFile } from "node:fs/promises";
import { resolve as resolvePath, join as pathJoin } from "node:path";
import { existsSync } from "node:fs";
import { confirm } from "@inquirer/prompts";
import { logger } from "../../logger/logger.js";
import { isInsideGitRepo } from "../../utils/git.js";
import { getCurrentBranch, detectBaseBranch, getBranchCommits, getBranchDiff, getBranchStat } from "../../utils/gitOps.js";
import { GitxError } from "../../utils/errors.js";
import { Gitx } from "../../core/gitx.js";
import { createProvider } from "../../providers/factory.js";

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

// ─── Port state file ──────────────────────────────────────────────────────────
// Saved to .git/GITX_PORT so --continue knows where to resume.

interface PortState {
  sourceBranch: string;
  portBranch: string;
  targetBranch: string;
  remainingCommits: string[]; // SHAs oldest→newest still to cherry-pick
  noPr: boolean;
  draft: boolean;
}

async function loadPortState(cwd: string): Promise<PortState | null> {
  const { stdout: gitDir } = await git(["rev-parse", "--git-dir"], cwd);
  const statePath = pathJoin(cwd, gitDir || ".git", "GITX_PORT");
  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as PortState;
  } catch {
    return null;
  }
}

async function savePortState(cwd: string, state: PortState): Promise<void> {
  const { stdout: gitDir } = await git(["rev-parse", "--git-dir"], cwd);
  const statePath = pathJoin(cwd, gitDir || ".git", "GITX_PORT");
  await fsWriteFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function clearPortState(cwd: string): Promise<void> {
  const { stdout: gitDir } = await git(["rev-parse", "--git-dir"], cwd);
  const statePath = pathJoin(cwd, gitDir || ".git", "GITX_PORT");
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(statePath);
  } catch { /* already gone */ }
}

// ─── Conflict detection ───────────────────────────────────────────────────────

async function getConflictingFiles(cwd: string): Promise<string[]> {
  const { stdout } = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function isCherryPickInProgress(cwd: string): Promise<boolean> {
  const { stdout: gitDir } = await git(["rev-parse", "--git-dir"], cwd);
  const cherryPickHead = pathJoin(cwd, gitDir || ".git", "CHERRY_PICK_HEAD");
  return existsSync(cherryPickHead);
}

// ─── Incremental commit detection ────────────────────────────────────────────

/**
 * Use `git cherry <upstreamBranch> <headBranch>` to find commits in headBranch
 * that are NOT yet present in upstreamBranch (by patch-id comparison).
 *
 * Returns SHAs of unported commits, oldest-first.
 * Lines prefixed with '+' are not yet ported; '-' are already present.
 */
async function getUnportedCommits(
  cwd: string,
  portBranch: string,
  sourceBranch: string
): Promise<string[]> {
  // git cherry compares patch IDs — works even when SHAs differ after cherry-pick
  const { stdout } = await git(
    ["cherry", portBranch, sourceBranch],
    cwd
  );
  const lines = stdout.split("\n").filter(Boolean);
  // '+' = not on portBranch (needs porting), '-' = already there
  const unported = lines
    .filter((l) => l.startsWith("+ "))
    .map((l) => l.slice(2).trim());
  // git cherry returns newest-first; reverse to get oldest-first for cherry-pick
  return unported.reverse();
}

/**
 * Get ALL commits on the current branch (base..HEAD), oldest-first.
 * These are the SHAs we'll cherry-pick on a first run.
 */
async function getAllBranchCommitShas(
  cwd: string,
  baseBranch: string
): Promise<string[]> {
  const { stdout } = await git(
    ["log", "--format=%H", "--no-decorate", `${baseBranch}..HEAD`],
    cwd
  );
  const shas = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  // git log returns newest-first; reverse to oldest-first
  return shas.reverse();
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
        const preview = result.resolved.split("\n").slice(0, 30).join("\n");
        logger.info(`\n${preview}\n`);

        let apply = false;
        try {
          apply = await confirm({ message: `Apply AI resolution for ${filePath}?`, default: true });
        } catch { apply = false; }

        if (apply) {
          await writeFile(absPath, result.resolved, "utf8");
          logger.success(`  ✅ Applied: ${filePath}`);
          resolved.push(filePath);
        } else {
          needsManual.push(filePath);
        }
      }
    } catch {
      spinner.fail(`  ❌ AI resolution failed: ${filePath} — resolve manually`);
      needsManual.push(filePath);
    }
  }

  return { resolved, needsManual };
}

// ─── Cherry-pick a list of commits ───────────────────────────────────────────

interface CherryPickResult {
  status: "success" | "paused";
  remainingCommits: string[];  // only set when status is "paused"
}

async function cherryPickCommits(
  commits: string[],
  cwd: string,
  gitx: Gitx
): Promise<CherryPickResult> {
  for (let i = 0; i < commits.length; i++) {
    const sha = commits[i]!;
    const shortSha = sha.slice(0, 7);

    // Get the commit subject for display
    const { stdout: subject } = await git(
      ["log", "--format=%s", "-1", sha],
      cwd
    );

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
      // Some other error (e.g. empty commit)
      logger.warn(`     ⚠️  Skipping (empty or already applied): ${shortSha}`);
      await git(["cherry-pick", "--skip"], cwd);
      continue;
    }

    logger.warn(`\n  ⚡ Conflicts in ${conflictFiles.length} file(s):`);
    conflictFiles.forEach((f) => logger.info(`     • ${f}`));

    const { resolved, needsManual } = await resolveConflictsWithAi(conflictFiles, cwd, gitx);

    if (needsManual.length > 0) {
      // Can't auto-resolve everything — pause and let user fix manually
      logger.warn(`\n  ⛔ ${needsManual.length} file(s) need manual resolution:`);
      needsManual.forEach((f) => logger.warn(`     • ${f}`));

      // Stage the auto-resolved files so user only needs to fix the rest
      if (resolved.length > 0) {
        await git(["add", ...resolved], cwd);
        logger.info(`\n  ✅ Auto-resolved files have been staged.`);
      }

      return {
        status: "paused",
        remainingCommits: commits.slice(i), // include current commit (still in progress)
      };
    }

    // All conflicts resolved — stage and continue
    await git(["add", ...resolved], cwd);
    const continueResult = await git(
      ["cherry-pick", "--continue", "--no-edit"],
      cwd
    );

    if (continueResult.exitCode !== 0) {
      // Still failing — pause
      return {
        status: "paused",
        remainingCommits: commits.slice(i),
      };
    }

    logger.success(`     ✅ Conflict resolved and applied`);
  }

  return { status: "success", remainingCommits: [] };
}

// ─── Port a single target branch ─────────────────────────────────────────────

async function portToTarget(opts: {
  sourceBranch: string;
  targetBranch: string;
  baseBranch: string;
  cwd: string;
  gitx: Gitx;
  noPr: boolean;
  draft: boolean;
}): Promise<void> {
  const { sourceBranch, targetBranch, baseBranch, cwd, gitx, noPr, draft } = opts;
  const portBranch = `port/${sourceBranch.replace(/\//g, "-")}-to-${targetBranch.replace(/\//g, "-")}`;

  logger.info(`\n${"─".repeat(60)}`);
  logger.info(`🎯 Target: ${targetBranch}`);
  logger.info(`   Port branch: ${portBranch}`);

  // ── 1. Fetch origin ────────────────────────────────────────────────────────
  const fetchSpinner = ora("Fetching origin…").start();
  const fetchResult = await git(["fetch", "origin"], cwd);
  if (fetchResult.exitCode !== 0) {
    fetchSpinner.fail(`fetch failed: ${fetchResult.stderr}`);
    return;
  }
  fetchSpinner.succeed("Fetched origin");

  // ── 2. Check if target branch exists on origin ────────────────────────────
  const { stdout: remoteRefs } = await git(
    ["ls-remote", "--heads", "origin", targetBranch],
    cwd
  );
  if (!remoteRefs.trim()) {
    logger.error(`  ❌ Branch "${targetBranch}" does not exist on origin. Skipping.`);
    return;
  }

  // ── 3. Determine which commits to port ────────────────────────────────────
  const portBranchExistsRemote = (await git(
    ["ls-remote", "--heads", "origin", portBranch],
    cwd
  )).stdout.trim().length > 0;

  const portBranchExistsLocal = (await git(
    ["rev-parse", "--verify", portBranch],
    cwd
  )).exitCode === 0;

  const portBranchExists = portBranchExistsLocal || portBranchExistsRemote;

  let commitShas: string[];

  if (portBranchExists) {
    // Incremental run — use git cherry to find only NEW commits
    const localRef = portBranchExistsLocal
      ? portBranch
      : `origin/${portBranch}`;

    const unported = await getUnportedCommits(cwd, localRef, sourceBranch);

    if (unported.length === 0) {
      logger.success(`  ✅ Already up to date — nothing new to port to ${targetBranch}`);
      return;
    }

    logger.info(`  📋 ${unported.length} new commit(s) to port (incremental):`);
    for (const sha of unported) {
      const { stdout: subject } = await git(["log", "--format=%s", "-1", sha], cwd);
      logger.info(`     + ${sha.slice(0, 7)} — ${subject}`);
    }

    commitShas = unported;
  } else {
    // First run — port all commits on this branch
    commitShas = await getAllBranchCommitShas(cwd, baseBranch);

    if (commitShas.length === 0) {
      logger.warn(`  ⚠️  No commits found on "${sourceBranch}" since "${baseBranch}". Nothing to port.`);
      return;
    }

    logger.info(`  📋 ${commitShas.length} commit(s) to port:`);
    for (const sha of commitShas) {
      const { stdout: subject } = await git(["log", "--format=%s", "-1", sha], cwd);
      logger.info(`     + ${sha.slice(0, 7)} — ${subject}`);
    }
  }

  const proceed = await confirm({
    message: `Port ${commitShas.length} commit(s) to ${targetBranch}?`,
    default: true,
  });
  if (!proceed) {
    logger.info("  Skipped.");
    return;
  }

  // ── 4. Create or checkout the port branch ─────────────────────────────────
  if (portBranchExists) {
    // Checkout and update from origin if it exists remotely
    if (portBranchExistsLocal) {
      await git(["checkout", portBranch], cwd);
    } else {
      await git(["checkout", "-b", portBranch, `origin/${portBranch}`], cwd);
    }
    // Pull latest from origin if it's there
    if (portBranchExistsRemote) {
      await git(["pull", "--ff-only", "origin", portBranch], cwd);
    }
  } else {
    // Create fresh from origin/<target>
    const checkoutResult = await git(
      ["checkout", "-b", portBranch, `origin/${targetBranch}`],
      cwd
    );
    if (checkoutResult.exitCode !== 0) {
      logger.error(`  ❌ Could not create port branch: ${checkoutResult.stderr}`);
      return;
    }
  }

  // ── 5. Cherry-pick ─────────────────────────────────────────────────────────
  const pickResult = await cherryPickCommits(commitShas, cwd, gitx);

  if (pickResult.status === "paused") {
    // Save state and bail — user needs to fix conflicts manually
    await savePortState(cwd, {
      sourceBranch,
      portBranch,
      targetBranch,
      remainingCommits: pickResult.remainingCommits,
      noPr,
      draft,
    });

    logger.warn(`\n  ⛔ Port paused — manual conflict resolution needed.`);
    logger.info(`\n  Fix the conflicts above, then run:`);
    logger.info(`     git add <resolved-files>`);
    logger.info(`     gitx port --continue`);
    logger.info(`\n  Or to abandon this port:`);
    logger.info(`     gitx port --abort`);
    return;
  }

  // ── 6. Push port branch ────────────────────────────────────────────────────
  const pushSpinner = ora(`Pushing ${portBranch}…`).start();
  const pushResult = await git(
    ["push", "--force-with-lease", "--set-upstream", "origin", portBranch],
    cwd
  );
  if (pushResult.exitCode !== 0) {
    pushSpinner.fail(`Push failed: ${pushResult.stderr}`);
    return;
  }
  pushSpinner.succeed(`Pushed ${portBranch}`);

  // ── 7. Create PR ───────────────────────────────────────────────────────────
  if (noPr) {
    logger.success(`\n  ✅ Port branch pushed: ${portBranch}`);
    logger.info(`     Create PR manually: ${portBranch} → ${targetBranch}`);
    return;
  }

  let ctx;
  try {
    ctx = await gitx.getRepoContext();
  } catch {
    logger.warn(`  ⚠️  Could not get repo context for PR creation — create PR manually.`);
    logger.success(`  ✅ Port branch pushed: ${portBranch}`);
    return;
  }

  const provider = createProvider(ctx);

  // Check if a PR already exists for this port branch
  let existingPrUrl: string | undefined;
  try {
    const allPrs = await provider.listPRs(ctx.repoSlug);
    const existing = allPrs.find(
      (pr) => pr.head === portBranch && pr.base === targetBranch && pr.state === "open"
    );
    if (existing) {
      existingPrUrl = existing.url;
    }
  } catch { /* non-fatal */ }

  if (existingPrUrl) {
    logger.success(`  ✅ PR already open — updated with new commits: ${existingPrUrl}`);
    return;
  }

  // Generate PR content with AI
  const prSpinner = ora("Generating PR description…").start();
  let prTitle = `[Port → ${targetBranch}] ${sourceBranch}`;
  let prBody = `Ported from \`${sourceBranch}\` → \`${targetBranch}\`.\n\n`;
  prBody += `Cherry-picked ${commitShas.length} commit(s):\n`;
  for (const sha of commitShas) {
    const { stdout: subject } = await git(["log", "--format=%s", "-1", sha], cwd);
    prBody += `- ${sha.slice(0, 7)} ${subject}\n`;
  }

  try {
    const commits = await getBranchCommits(cwd, targetBranch);
    const diff = await getBranchDiff(cwd, `origin/${targetBranch}`);
    const stat = await getBranchStat(cwd, `origin/${targetBranch}`);
    const aiContent = await gitx.ai.generatePrContent(commits, diff, stat || undefined);
    // Prepend port context to AI-generated body
    prTitle = `[Port → ${targetBranch}] ${aiContent.title}`;
    prBody = `> 🍒 Ported from \`${sourceBranch}\` → \`${targetBranch}\` (${commitShas.length} commit(s))\n\n${aiContent.body}`;
    prSpinner.succeed("PR description generated");
  } catch {
    prSpinner.warn("Could not generate AI description — using commit list");
  }

  try {
    const createdPr = await provider.createPR(ctx.repoSlug, {
      title: prTitle,
      body: prBody,
      head: portBranch,
      base: targetBranch,
      draft,
    });
    logger.success(`\n  ✅ PR created: ${createdPr.url}`);
    logger.info(`     #${createdPr.number} — ${createdPr.title}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`  ⚠️  PR creation failed: ${msg}`);
    logger.info(`     Create manually: ${portBranch} → ${targetBranch}`);
  }
}

// ─── Register command ─────────────────────────────────────────────────────────

export function registerPortCommand(program: Command): void {
  program
    .command("port")
    .description(
      "🍒 Port commits from the current branch to one or more other branches\n" +
      "   Smart incremental: only ports NEW commits on re-runs\n" +
      "   Example: gitx port release/v2 hotfix/v1"
    )
    .argument("[targets...]", "Target branch(es) to port commits onto")
    .option("--base <branch>", "Base branch to calculate commits from (auto-detected if omitted)")
    .option("--no-pr", "Push the port branch but skip PR creation")
    .option("--draft", "Create PRs as drafts")
    .option("--continue", "Continue after manually resolving cherry-pick conflicts")
    .option("--abort", "Abort a paused port and clean up")
    .action(async (
      targets: string[],
      opts: { base?: string; pr: boolean; draft: boolean; continue?: boolean; abort?: boolean }
    ) => {
      const cwd = process.cwd();

      if (!(await isInsideGitRepo(cwd))) {
        throw new GitxError("Not inside a git repository. cd into your project folder first.", { exitCode: 2 });
      }

      const gitx = await Gitx.fromCwd(cwd);

      // ── --abort ─────────────────────────────────────────────────────────────
      if (opts.abort) {
        const inProgress = await isCherryPickInProgress(cwd);
        if (inProgress) {
          await git(["cherry-pick", "--abort"], cwd);
        }
        const state = await loadPortState(cwd);
        if (state) {
          // Return to source branch
          await git(["checkout", state.sourceBranch], cwd);
          await clearPortState(cwd);
          logger.success(`✅ Port aborted. Back on ${state.sourceBranch}.`);
        } else {
          logger.info("No port in progress to abort.");
        }
        return;
      }

      // ── --continue ──────────────────────────────────────────────────────────
      if (opts.continue) {
        const state = await loadPortState(cwd);
        if (!state) {
          throw new GitxError(
            "No port in progress. Run `gitx port <target>` to start one.",
            { exitCode: 2 }
          );
        }

        // Make sure cherry-pick is no longer paused (user staged their fixes)
        const cherryInProgress = await isCherryPickInProgress(cwd);
        if (cherryInProgress) {
          // Complete the current cherry-pick
          const continueResult = await git(
            ["cherry-pick", "--continue", "--no-edit"],
            cwd
          );
          if (continueResult.exitCode !== 0) {
            const remaining = await getConflictingFiles(cwd);
            if (remaining.length > 0) {
              logger.warn("Still has conflicts — resolve them and stage before running --continue again.");
              remaining.forEach((f) => logger.warn(`  • ${f}`));
              return;
            }
          }
        }

        // Resume remaining commits (skip the first — it was the one in conflict)
        const toResume = state.remainingCommits.slice(1);

        if (toResume.length > 0) {
          logger.info(`\n▶ Resuming port — ${toResume.length} commit(s) remaining…`);
          const pickResult = await cherryPickCommits(toResume, cwd, gitx);

          if (pickResult.status === "paused") {
            await savePortState(cwd, { ...state, remainingCommits: pickResult.remainingCommits });
            logger.warn("Port paused again — fix conflicts and run `gitx port --continue`.");
            return;
          }
        }

        // All done — push and create PR
        await clearPortState(cwd);

        const pushSpinner = ora(`Pushing ${state.portBranch}…`).start();
        const pushResult = await git(
          ["push", "--force-with-lease", "--set-upstream", "origin", state.portBranch],
          cwd
        );
        if (pushResult.exitCode !== 0) {
          pushSpinner.fail(`Push failed: ${pushResult.stderr}`);
          return;
        }
        pushSpinner.succeed(`Pushed ${state.portBranch}`);

        if (!state.noPr) {
          let ctx;
          try {
            ctx = await gitx.getRepoContext();
            const provider = createProvider(ctx);
            const createdPr = await provider.createPR(ctx.repoSlug, {
              title: `[Port → ${state.targetBranch}] ${state.sourceBranch}`,
              body: `Ported from \`${state.sourceBranch}\` → \`${state.targetBranch}\` (manual conflict resolution).`,
              head: state.portBranch,
              base: state.targetBranch,
              draft: state.draft,
            });
            logger.success(`✅ PR created: ${createdPr.url}`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`PR creation failed: ${msg} — create manually.`);
          }
        } else {
          logger.success(`✅ Port complete. Branch: ${state.portBranch}`);
        }

        // Return to source branch
        await git(["checkout", state.sourceBranch], cwd);
        return;
      }

      // ── Normal port run ─────────────────────────────────────────────────────
      if (targets.length === 0) {
        throw new GitxError(
          "Specify at least one target branch.\n  Example: gitx port release/v2 hotfix/v1",
          { exitCode: 2 }
        );
      }

      const sourceBranch = await getCurrentBranch(cwd);
      if (!sourceBranch) {
        throw new GitxError("Could not determine current branch.", { exitCode: 2 });
      }

      // Prevent porting to the same branch
      const invalidTargets = targets.filter((t) => t === sourceBranch);
      if (invalidTargets.length > 0) {
        throw new GitxError(
          `Cannot port a branch onto itself: ${invalidTargets.join(", ")}`,
          { exitCode: 2 }
        );
      }

      const baseBranch = opts.base ?? (await detectBaseBranch(cwd));

      logger.info(`\n🍒 gitx port`);
      logger.info(`   Source:  ${sourceBranch}`);
      logger.info(`   Base:    ${baseBranch}`);
      logger.info(`   Targets: ${targets.join(", ")}`);

      const originalBranch = sourceBranch;

      for (const targetBranch of targets) {
        await portToTarget({
          sourceBranch,
          targetBranch,
          baseBranch,
          cwd,
          gitx,
          noPr: opts.pr === false,
          draft: opts.draft,
        });

        // Return to source branch between targets
        const { stdout: currentBranch } = await git(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          cwd
        );
        if (currentBranch !== originalBranch) {
          await git(["checkout", originalBranch], cwd);
        }
      }

      logger.info(`\n${"─".repeat(60)}`);
      logger.success(`\n✅ gitx port complete.`);
    });
}
