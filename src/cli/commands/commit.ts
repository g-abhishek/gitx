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
import { unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger/logger.js";
import { Gitx } from "../../core/gitx.js";
import {
  stageAll,
  hasStagedChanges,
  isWorkingTreeDirty,
  getWorkingDiff,
  commitChanges,
  pushBranch,
  getCurrentBranch,
} from "../../utils/gitOps.js";
import { isInsideGitRepo } from "../../utils/git.js";
import { GitxError } from "../../utils/errors.js";

/**
 * Handle .git/index.lock errors safely.
 *
 * A lock file can mean two things:
 *   A) A previous git process crashed and left a stale lock (safe to remove)
 *   B) Another git process is actively running right now (UNSAFE to remove)
 *
 * We distinguish them by checking the lock file's age:
 *   - Older than STALE_THRESHOLD_MS → almost certainly stale, safe to remove
 *   - Newer than threshold           → likely active, warn user and abort
 *
 * We never silently delete a fresh lock — that risks index corruption.
 */
const STALE_THRESHOLD_MS = 30_000; // 30 seconds

async function withLockRetry<T>(fn: () => Promise<T>, cwd: string): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("index.lock")) throw err;

    const lockPath = join(cwd, ".git", "index.lock");

    // Check how old the lock file is
    let ageMs = Infinity;
    try {
      const info = await stat(lockPath);
      ageMs = Date.now() - info.mtimeMs;
    } catch {
      // Lock file already gone — just retry
      return await fn();
    }

    if (ageMs < STALE_THRESHOLD_MS) {
      // Lock is fresh — another git process is likely running right now
      throw new GitxError(
        "A git process appears to be running in this repo (index.lock is recent).\n" +
        "  Wait for it to finish, then retry.\n" +
        "  If you're sure nothing is running:\n" +
        `    rm "${lockPath}"`,
        { exitCode: 1 }
      );
    }

    // Lock is old — safe to treat as stale and remove
    logger.warn(`⚠️  Found stale .git/index.lock (${Math.round(ageMs / 1000)}s old) — removing and retrying…`);
    try {
      await unlink(lockPath);
    } catch {
      throw new GitxError(
        `Could not remove stale lock file: "${lockPath}"\n  Try: rm "${lockPath}"`,
        { exitCode: 1 }
      );
    }

    return await fn(); // retry once after removing stale lock
  }
}

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
      const diff = await getWorkingDiff(cwd);

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
            const result = await gitx.ai.summarizeChanges({ rawDiff: diff });

            // Convert the AI summary to a conventional-commit style message
            const summary = result.summary.trim();
            const files = result.filesChanged ?? [];

            // Infer conventional commit type from changed files / summary
            const type = inferCommitType(summary, files.map((f) => f.path));
            const scope = inferScope(files.map((f) => f.path));
            const headline = buildHeadline(type, scope, summary);

            // Build full message with body listing changed files
            const body = files.length > 0
              ? "\n\n" + files.map((f) => `- ${f.changeType}: ${f.path}`).join("\n")
              : "";

            commitMsg = headline + body;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Infer a conventional commit type from summary text and file paths. */
function inferCommitType(summary: string, paths: string[]): string {
  const s = summary.toLowerCase();
  const p = paths.join(" ").toLowerCase();

  if (/fix|bug|error|crash|broken|patch/.test(s)) return "fix";
  if (/test|spec/.test(p) || /test/.test(s)) return "test";
  if (/doc|readme|changelog/.test(p) || /document|readme/.test(s)) return "docs";
  if (/refactor|rename|restructur|reorgan|clean/.test(s)) return "refactor";
  if (/style|format|lint|prettier|eslint/.test(s)) return "style";
  if (/chore|build|deps|dependency|package/.test(s) || /package\.json|\.lock/.test(p)) return "chore";
  if (/config|setting|env/.test(p) || /configur/.test(s)) return "chore";
  if (/perf|optim|speed|faster|slower/.test(s)) return "perf";
  if (/ci|workflow|action|pipeline/.test(p)) return "ci";
  return "feat";
}

/** Derive a short scope from the most commonly touched directory. */
function inferScope(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;

  // Count top-level directories
  const dirs: Record<string, number> = {};
  for (const p of paths) {
    const parts = p.replace(/^src\//, "").split("/");
    const dir = parts.length > 1 ? parts[0] : "";
    if (dir) dirs[dir] = (dirs[dir] ?? 0) + 1;
  }

  const sorted = Object.entries(dirs).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0]; // most touched top-level dir
}

/** Build a conventional commit headline under 72 chars. */
function buildHeadline(type: string, scope: string | undefined, summary: string): string {
  const prefix = scope ? `${type}(${scope})` : type;

  // Strip trailing period, capitalise first char of description
  const desc = summary.replace(/\.$/, "");
  const short = desc.length > 60 ? desc.slice(0, 57) + "…" : desc;

  return `${prefix}: ${short}`;
}
