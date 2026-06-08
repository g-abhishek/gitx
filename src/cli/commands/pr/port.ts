/**
 * gitx pr port <number> <target1> [target2...]
 *
 * Ports all commits from a PR onto one or more target branches, then opens
 * a new PR for each target — without touching your current working branch.
 *
 * Example:
 *   gitx pr port 12345 release/v1 release/v2
 *
 *   → Creates  port/pr-12345-to-release-v1  from origin/release/v1
 *              port/pr-12345-to-release-v2  from origin/release/v2
 *   → Cherry-picks all commits from PR #12345 onto each port branch
 *   → Pushes both port branches
 *   → Opens a PR for each: port branch → target branch
 *   → Prints the PR URLs
 *
 * Flow (per target branch):
 *   1. Fetch PR metadata → source branch (head) + base branch
 *   2. git fetch origin <head>  — ensure source commits are local
 *   3. Collect commits: origin/<base>..origin/<head>  (oldest → newest)
 *   4. Create port/pr-<number>-to-<target> from origin/<target>
 *   5. Cherry-pick each commit with -x; AI resolves conflicts where possible
 *   6. Push port branch
 *   7. Create PR: port branch → target branch; print URL
 *
 * Options:
 *   --no-pr       Push port branches but skip PR creation
 *   --draft       Create PRs as drafts
 *   --dry-run     Show what would happen without making any changes
 *   --no-confirm  Skip the per-target confirmation prompt
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

// ─── Conflict helpers ─────────────────────────────────────────────────────────

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
        const preview = result.resolved.split("\n").slice(0, 30).join("\n");
        logger.info(`\n${preview}\n`);

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

// ─── Cherry-pick loop ─────────────────────────────────────────────────────────

interface Commit {
  sha: string;
  subject: string;
}

interface CherryPickResult {
  status: "success" | "paused";
  pausedAt?: Commit;
}

async function cherryPickCommits(
  commits: Commit[],
  cwd: string,
  gitx: Gitx,
  aiAvailable: boolean
): Promise<CherryPickResult> {
  for (let i = 0; i < commits.length; i++) {
    const { sha, subject } = commits[i]!;
    const shortSha = sha.slice(0, 7);

    logger.info(`\n  🍒 [${i + 1}/${commits.length}] ${shortSha} — ${subject}`);

    const result = await git(["cherry-pick", "-x", sha], cwd);

    if (result.exitCode === 0) {
      logger.success(`     ✓ Applied cleanly`);
      continue;
    }

    const conflictFiles = await getConflictingFiles(cwd);

    if (conflictFiles.length === 0) {
      logger.warn(`     ⚠️  Skipping (empty or already applied): ${shortSha}`);
      await git(["cherry-pick", "--skip"], cwd);
      continue;
    }

    logger.warn(`\n  ⚡ Conflicts in ${conflictFiles.length} file(s):`);
    conflictFiles.forEach((f) => logger.info(`     • ${f}`));

    if (!aiAvailable) {
      logger.error(`\n  ⛔ Manual conflict resolution needed. Aborting port to this target.`);
      logger.info(`  Run:  git cherry-pick --abort  (if needed) then fix manually.`);
      await git(["cherry-pick", "--abort"], cwd);
      return { status: "paused", pausedAt: commits[i] };
    }

    const { resolved, needsManual } = await resolveConflictsWithAi(conflictFiles, cwd, gitx);

    if (needsManual.length > 0) {
      if (resolved.length > 0) {
        await git(["add", ...resolved], cwd);
        logger.info(`\n  ✅ Auto-resolved ${resolved.length} file(s) — staged.`);
      }
      logger.warn(`\n  ⛔ ${needsManual.length} file(s) need manual resolution. Aborting port to this target.`);
      needsManual.forEach((f) => logger.warn(`     • ${f}`));
      await git(["cherry-pick", "--abort"], cwd);
      return { status: "paused", pausedAt: commits[i] };
    }

    await git(["add", ...resolved], cwd);
    const continueResult = await git(["cherry-pick", "--continue", "--no-edit"], cwd);
    if (continueResult.exitCode !== 0) {
      logger.error(`  ❌ Could not continue cherry-pick: ${continueResult.stderr}`);
      await git(["cherry-pick", "--abort"], cwd);
      return { status: "paused", pausedAt: commits[i] };
    }

    logger.success(`     ✅ Conflict resolved and applied`);
  }

  return { status: "success" };
}

// ─── Port to a single target branch ──────────────────────────────────────────

interface PortResult {
  target: string;
  portBranch: string;
  prUrl?: string;
  skipped?: string; // reason why this target was skipped
  conflictAt?: string; // SHA of commit that caused an unresolvable conflict
}

async function portPrToTarget(opts: {
  prNumber: number;
  prTitle: string;
  prHeadBranch: string;
  prBaseBranch: string;
  commits: Commit[];
  targetBranch: string;
  cwd: string;
  gitx: Gitx;
  noPr: boolean;
  draft: boolean;
  skipConfirm: boolean;
  aiAvailable: boolean;
  originalBranch: string;
}): Promise<PortResult> {
  const {
    prNumber, prTitle, prHeadBranch, prBaseBranch,
    commits, targetBranch, cwd, gitx,
    noPr, draft, skipConfirm, aiAvailable, originalBranch,
  } = opts;

  const safePrNum = String(prNumber);
  const safeTarget = targetBranch.replace(/\//g, "-");
  const portBranch = `port/pr-${safePrNum}-to-${safeTarget}`;

  logger.info(`\n${"─".repeat(60)}`);
  logger.info(`🎯 Target: ${targetBranch}`);
  logger.info(`   Port branch: ${portBranch}`);

  // ── 1. Verify target exists on origin ──────────────────────────────────────
  const { stdout: remoteRefs } = await git(
    ["ls-remote", "--heads", "origin", targetBranch],
    cwd
  );
  if (!remoteRefs.trim()) {
    logger.error(`  ❌ Branch "${targetBranch}" does not exist on origin. Skipping.`);
    return { target: targetBranch, portBranch, skipped: `branch "${targetBranch}" not found on origin` };
  }

  // ── 2. Check if port branch already exists ─────────────────────────────────
  const portExistsRemote = (await git(
    ["ls-remote", "--heads", "origin", portBranch], cwd
  )).stdout.trim().length > 0;

  const portExistsLocal = (await git(
    ["rev-parse", "--verify", portBranch], cwd
  )).exitCode === 0;

  if (portExistsRemote || portExistsLocal) {
    logger.warn(`  ⚠️  Port branch "${portBranch}" already exists — deleting and recreating for a clean port.`);
    if (portExistsLocal) {
      // Make sure we're not on it before deleting
      await git(["checkout", originalBranch], cwd);
      await git(["branch", "-D", portBranch], cwd);
    }
  }

  // ── 3. Confirmation ─────────────────────────────────────────────────────────
  if (!skipConfirm) {
    let proceed = false;
    try {
      proceed = await confirm({
        message: `Port ${commits.length} commit(s) from PR #${prNumber} onto "${targetBranch}"?`,
        default: true,
      });
    } catch {
      proceed = false;
    }
    if (!proceed) {
      logger.info("  Skipped.");
      return { target: targetBranch, portBranch, skipped: "user skipped" };
    }
  }

  // ── 4. Create port branch from origin/<target> ────────────────────────────
  const checkoutResult = await git(
    ["checkout", "-b", portBranch, `origin/${targetBranch}`],
    cwd
  );
  if (checkoutResult.exitCode !== 0) {
    logger.error(`  ❌ Could not create port branch: ${checkoutResult.stderr}`);
    return { target: targetBranch, portBranch, skipped: `checkout failed: ${checkoutResult.stderr}` };
  }

  // ── 5. Cherry-pick commits ─────────────────────────────────────────────────
  const pickResult = await cherryPickCommits(commits, cwd, gitx, aiAvailable);

  // Return to original branch before reporting
  await git(["checkout", originalBranch], cwd);

  if (pickResult.status === "paused") {
    return {
      target: targetBranch,
      portBranch,
      conflictAt: pickResult.pausedAt?.sha,
      skipped: `conflict at ${pickResult.pausedAt?.sha.slice(0, 7) ?? "?"} (port branch not pushed)`,
    };
  }

  // ── 6. Push port branch ────────────────────────────────────────────────────
  const pushSpinner = ora(`  Pushing ${portBranch}…`).start();
  const pushResult = await git(
    ["push", "--force-with-lease", "--set-upstream", "origin", portBranch],
    cwd
  );
  if (pushResult.exitCode !== 0) {
    pushSpinner.fail(`  Push failed: ${pushResult.stderr}`);
    return { target: targetBranch, portBranch, skipped: `push failed: ${pushResult.stderr}` };
  }
  pushSpinner.succeed(`  Pushed ${portBranch}`);

  if (noPr) {
    logger.success(`  ✅ Port branch ready — create PR manually: ${portBranch} → ${targetBranch}`);
    return { target: targetBranch, portBranch };
  }

  // ── 7. Create PR ────────────────────────────────────────────────────────────
  let ctx;
  try {
    ctx = await gitx.getRepoContext();
  } catch {
    logger.warn(`  ⚠️  Could not get repo context for PR creation — create PR manually.`);
    return { target: targetBranch, portBranch };
  }

  const provider = createProvider(ctx);

  // Check if a PR already exists for this port branch
  try {
    const allPrs = await provider.listPRs(ctx.repoSlug);
    const existing = allPrs.find(
      (p) => p.head === portBranch && p.base === targetBranch && p.state === "open"
    );
    if (existing) {
      logger.success(`  ✅ PR already open — updated with new commits: ${existing.url}`);
      return { target: targetBranch, portBranch, prUrl: existing.url };
    }
  } catch { /* non-fatal */ }

  const prSpinner = ora(`  Creating PR: ${portBranch} → ${targetBranch}…`).start();

  const portedPrTitle = `[Port PR #${prNumber} → ${targetBranch}] ${prTitle}`;
  let prBody =
    `> 🍒 Port of PR #${prNumber} onto \`${targetBranch}\`\n` +
    `> Original: \`${prHeadBranch}\` → \`${prBaseBranch}\`\n\n` +
    `**${prTitle}**\n\n` +
    `Cherry-picked ${commits.length} commit(s):\n` +
    commits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`).join("\n");

  // Try AI-generated PR body
  try {
    const aiContent = await gitx.ai.generatePrContent(
      commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`),
      "", // no diff available in this context
    );
    prBody =
      `> 🍒 Port of PR #${prNumber} onto \`${targetBranch}\`\n` +
      `> Original: \`${prHeadBranch}\` → \`${prBaseBranch}\`\n\n` +
      aiContent.body;
  } catch { /* use manual body */ }

  try {
    const createdPr = await provider.createPR(ctx.repoSlug, {
      title: portedPrTitle,
      body: prBody,
      head: portBranch,
      base: targetBranch,
      draft,
    });
    prSpinner.succeed(`  PR created: ${createdPr.url}`);
    return { target: targetBranch, portBranch, prUrl: createdPr.url };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    prSpinner.warn(`  PR creation failed: ${msg}`);
    logger.info(`  Create manually: ${portBranch} → ${targetBranch}`);
    return { target: targetBranch, portBranch };
  }
}

// ─── Register command ─────────────────────────────────────────────────────────

export function registerPrPortCommand(pr: Command): void {
  pr
    .command("port")
    .description(
      "🚢 Port all commits from a PR onto one or more target branches and open PRs\n" +
      "   Example: gitx pr port 12345 release/v1 release/v2"
    )
    .argument("<number>", "PR number to port")
    .argument("<targets...>", "Target branch(es) to port the PR commits onto")
    .option("--no-pr", "Push port branches but skip PR creation")
    .option("--draft", "Create PRs as drafts")
    .option("--dry-run", "Show what would happen without making any changes")
    .option("--no-confirm", "Skip the per-target confirmation prompt")
    .action(async (
      prArg: string,
      targets: string[],
      opts: { pr: boolean; draft: boolean; dryRun?: boolean; confirm: boolean }
    ) => {
      const cwd = process.cwd();

      if (!(await isInsideGitRepo(cwd))) {
        throw new GitxError("Not inside a git repository.", { exitCode: 2 });
      }

      const prNumber = parseInt(prArg, 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        throw new GitxError(`Invalid PR number: "${prArg}"`, { exitCode: 2 });
      }

      if (targets.length === 0) {
        throw new GitxError(
          "Specify at least one target branch.\n  Example: gitx pr port 12345 release/v1 release/v2",
          { exitCode: 2 }
        );
      }

      const gitx = await Gitx.fromCwd(cwd);

      // ── Fetch PR metadata ──────────────────────────────────────────────────
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
      let prData;
      try {
        prData = await provider.getPR(ctx.repoSlug, prNumber);
        prSpinner.succeed(`PR #${prNumber}: "${prData.title}" (${prData.head} → ${prData.base})`);
      } catch (err: unknown) {
        prSpinner.fail(`Could not fetch PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      // ── Fetch the PR's source branch ───────────────────────────────────────
      const fetchSpinner = ora(`Fetching origin/${prData.head}…`).start();
      const fetchResult = await git(["fetch", "origin", prData.head], cwd);
      if (fetchResult.exitCode !== 0) {
        // Try GitHub's PR ref (works for merged/deleted branches too)
        const refResult = await git(
          ["fetch", "origin", `refs/pull/${prNumber}/head:refs/remotes/origin/pr/${prNumber}`],
          cwd
        );
        if (refResult.exitCode !== 0) {
          fetchSpinner.warn(`Could not fetch "${prData.head}" — it may have been deleted. Trying with local refs.`);
        } else {
          fetchSpinner.succeed(`Fetched PR #${prNumber} via refs/pull/${prNumber}/head`);
        }
      } else {
        fetchSpinner.succeed(`Fetched origin/${prData.head}`);
      }

      // ── Collect commits from the PR ────────────────────────────────────────
      const headRef =
        (await git(["rev-parse", "--verify", `origin/${prData.head}`], cwd)).exitCode === 0
          ? `origin/${prData.head}`
          : `origin/pr/${prNumber}`;

      const baseRef = `origin/${prData.base}`;

      const logResult = await git(
        ["log", "--format=%H %s", `${baseRef}..${headRef}`],
        cwd
      );

      if (logResult.exitCode !== 0 || !logResult.stdout.trim()) {
        logger.error(`❌ No commits found between ${baseRef} and ${headRef}.`);
        logger.info(`   Make sure "${prData.base}" exists on origin.`);
        process.exitCode = 1;
        return;
      }

      // git log is newest-first; reverse to oldest-first
      const commits: Commit[] = logResult.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const spaceIdx = line.indexOf(" ");
          return { sha: line.slice(0, spaceIdx), subject: line.slice(spaceIdx + 1) };
        })
        .reverse();

      if (commits.length === 0) {
        logger.info(`✅ PR #${prNumber} has no commits relative to "${prData.base}". Nothing to port.`);
        return;
      }

      // ── Summary ────────────────────────────────────────────────────────────
      logger.info(`\n🚢 gitx pr port`);
      logger.info(`   PR:      #${prNumber} — ${prData.title}`);
      logger.info(`   Source:  ${prData.head} → ${prData.base}`);
      logger.info(`   Commits: ${commits.length}`);
      logger.info(`   Targets: ${targets.join(", ")}`);

      if (opts.dryRun) {
        logger.info(`\n📋 Commits that would be ported:\n`);
        for (const { sha, subject } of commits) {
          logger.info(`   + ${sha.slice(0, 7)} — ${subject}`);
        }
        logger.info(`\n⏸  Dry run — no changes made.`);
        return;
      }

      const aiAvailable = await Gitx.isAiAvailable(gitx.config);
      if (!aiAvailable) {
        logger.warn("⚠️  No AI configured — conflicts will require manual intervention (target will be skipped).");
      }

      const originalBranch = await getCurrentBranch(cwd);

      // ── Port to each target ────────────────────────────────────────────────
      const results: PortResult[] = [];
      for (const targetBranch of targets) {
        const result = await portPrToTarget({
          prNumber,
          prTitle: prData.title,
          prHeadBranch: prData.head,
          prBaseBranch: prData.base,
          commits,
          targetBranch,
          cwd,
          gitx,
          noPr: opts.pr === false,
          draft: opts.draft,
          skipConfirm: opts.confirm === false,
          aiAvailable,
          originalBranch,
        });
        results.push(result);

        // Always return to original branch between targets
        const { stdout: cur } = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
        if (cur !== originalBranch) {
          await git(["checkout", originalBranch], cwd);
        }
      }

      // ── Final summary ──────────────────────────────────────────────────────
      logger.info(`\n${"─".repeat(60)}`);
      logger.info(`\n📋 gitx pr port summary — PR #${prNumber}\n`);

      const succeeded = results.filter((r) => r.prUrl);
      const pushed = results.filter((r) => !r.prUrl && !r.skipped);
      const skipped = results.filter((r) => r.skipped);

      if (succeeded.length > 0) {
        logger.success(`✅ PRs created (${succeeded.length}):`);
        for (const r of succeeded) {
          logger.info(`   ${r.target}`);
          logger.info(`     Branch: ${r.portBranch}`);
          logger.info(`     PR:     ${r.prUrl}`);
        }
      }

      if (pushed.length > 0) {
        logger.info(`\n🔀 Pushed (no PR created, ${pushed.length}):`);
        for (const r of pushed) {
          logger.info(`   ${r.portBranch} → create PR manually to ${r.target}`);
        }
      }

      if (skipped.length > 0) {
        logger.warn(`\n⚠️  Skipped (${skipped.length}):`);
        for (const r of skipped) {
          logger.warn(`   ${r.target}: ${r.skipped}`);
        }
      }
    });
}
