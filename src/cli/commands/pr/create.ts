/**
 * gitx pr create
 *
 * Fully automated PR creation workflow:
 *   1. If there are uncommitted changes → AI commit message → commit
 *   2. Push branch to origin
 *   3. If PR already exists → print its URL and exit
 *   4. Auto-detect base branch (upstream, remote HEAD, or closest ancestor)
 *   5. AI-generate PR title and body from branch commits + diff
 *   6. Show preview → confirm → create PR
 *
 * Usage:
 *   gitx pr create               # full auto
 *   gitx pr create --base main   # override base branch
 *   gitx pr create --draft       # open as draft
 *   gitx pr create --dry-run     # preview without creating
 */

import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { createProvider } from "../../../providers/factory.js";
import { GitHubProvider } from "../../../providers/github.js";
import {
  getCurrentBranch,
  isWorkingTreeDirty,
  hasStagedChanges,
  stageAll,
  commitChanges,
  pushBranch,
  getWorkingDiff,
  getWorkingDiffStat,
  detectBaseBranch,
  getBranchCommits,
  getBranchDiff,
} from "../../../utils/gitOps.js";
import { withLockRetry } from "../../../utils/lockFile.js";
import { GitxError } from "../../../utils/errors.js";

export function registerPrCreateCommand(pr: Command): void {
  pr.command("create")
    .description("🆕 Stage → commit → push → open a pull request in one step")
    .option("--base <base>", "Target / base branch (auto-detected if omitted)")
    .option("--draft", "Open as draft PR", false)
    .option("--dry-run", "Preview PR content without creating")
    .option("-m, --message <msg>", "Override the AI commit message")
    .option("--title <title>", "Override the AI-generated PR title")
    .option("--body <body>", "Override the AI-generated PR body")
    .action(
      async (options: {
        base?: string;
        draft: boolean;
        dryRun?: boolean;
        message?: string;
        title?: string;
        body?: string;
      }) => {
        const cwd = process.cwd();
        const gitx = await Gitx.fromCwd(cwd);
        const ctx = await gitx.getRepoContext();
        const provider = createProvider(ctx);

        // ── 1. Stage & AI-commit any uncommitted changes ───────────────────────
        const dirty = await isWorkingTreeDirty(cwd);
        const alreadyStaged = await hasStagedChanges(cwd);

        if (dirty || alreadyStaged) {
          logger.info("📂 Uncommitted changes detected — committing first.\n");

          if (dirty) {
            const stageSpinner = ora("Staging all changes…").start();
            await withLockRetry(() => stageAll(cwd), cwd);
            stageSpinner.succeed("All changes staged.");
          }

          // Get diff for AI commit message
          const [stat, workingDiff] = await Promise.all([
            getWorkingDiffStat(cwd),
            getWorkingDiff(cwd),
          ]);

          let commitMsg: string;

          if (options.message) {
            commitMsg = options.message;
            logger.info(`📝 Using provided commit message: ${commitMsg}`);
          } else {
            const aiCommitSpinner = ora("🤖 Generating commit message…").start();
            try {
              const aiInput = stat
                ? `=== Changed files (complete list) ===\n${stat}\n\n=== Detailed diff ===\n${workingDiff}`
                : workingDiff;
              const result = await gitx.ai.generateCommitMessage(aiInput);
              commitMsg = result.body
                ? `${result.subject}\n\n${result.body}`
                : result.subject;
              aiCommitSpinner.succeed(`Commit: ${result.subject}`);
            } catch (err) {
              aiCommitSpinner.fail("AI commit message generation failed.");
              logger.warn(`   ${err instanceof Error ? err.message : String(err)}`);

              const { manualMsg } = await inquirer.prompt<{ manualMsg: string }>([
                {
                  type: "input",
                  name: "manualMsg",
                  message: "Commit message:",
                  validate: (v: string) => v.trim().length > 0 || "Cannot be empty",
                },
              ]);
              commitMsg = manualMsg.trim();
            }
          }

          const commitSpinner = ora("Committing…").start();
          await withLockRetry(() => commitChanges(commitMsg, cwd), cwd);
          commitSpinner.succeed("Committed ✓");
        } else {
          logger.info("✨ Working tree is clean — skipping commit step.");
        }

        // ── 2. Determine current branch ────────────────────────────────────────
        const head = await getCurrentBranch(cwd);

        // ── 3. Detect / resolve base branch ───────────────────────────────────
        let base: string;
        if (options.base) {
          base = options.base;
          logger.info(`📌 Base branch (provided): ${base}`);
        } else {
          const detectSpinner = ora("Detecting base branch…").start();
          base = await detectBaseBranch(cwd);
          detectSpinner.succeed(`Base branch: ${base}`);
        }

        if (head === base) {
          throw new GitxError(
            `You are on "${head}" which is also the base branch.\n` +
            `  Create a feature branch first:  git checkout -b my-feature`,
            { exitCode: 1 }
          );
        }

        logger.info(`\n🔀 ${ctx.repoSlug}  ·  ${head} → ${base}\n`);

        // ── 4. Push branch ─────────────────────────────────────────────────────
        const pushSpinner = ora(`Pushing ${head} to origin…`).start();
        await pushBranch(head, cwd);
        pushSpinner.succeed("Pushed ✓");

        // ── 5. Check for existing open PR ──────────────────────────────────────
        if (provider instanceof GitHubProvider) {
          const existing = await provider.findExistingPR(ctx.repoSlug, head, base);
          if (existing) {
            logger.warn(`\n⚠️  A PR already exists for ${head} → ${base}:`);
            logger.info(`   #${existing.number} — ${existing.title}`);
            logger.success(`   ${existing.url}`);
            return;
          }
        } else {
          // GitLab / Azure: scan open PR list for matching head branch
          try {
            const openPrs = await provider.listPRs(ctx.repoSlug);
            const existing = openPrs.find(
              (p) => p.head === head && p.base === base && p.state === "open"
            );
            if (existing) {
              logger.warn(`\n⚠️  A PR already exists for ${head} → ${base}:`);
              logger.info(`   #${existing.number} — ${existing.title}`);
              logger.success(`   ${existing.url}`);
              return;
            }
          } catch {
            // Non-fatal — proceed to create
          }
        }

        // ── 6. AI-generate PR title & body ─────────────────────────────────────
        let prTitle = options.title ?? "";
        let prBody = options.body ?? "";

        if (!prTitle || !prBody) {
          const prSpinner = ora("🤖 Generating PR title and description…").start();
          try {
            const [commits, branchDiff] = await Promise.all([
              getBranchCommits(cwd, base),
              getBranchDiff(cwd, base),
            ]);

            const aiResult = await gitx.ai.generatePrContent(commits, branchDiff);
            if (!prTitle) prTitle = aiResult.title;
            if (!prBody) prBody = aiResult.body;
            prSpinner.succeed("PR content generated.");
          } catch (err) {
            prSpinner.fail("AI PR generation failed — falling back to manual entry.");
            logger.warn(`   ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Fallback: prompt for any still-missing values
        if (!prTitle) {
          const ans = await inquirer.prompt<{ title: string }>([
            {
              type: "input",
              name: "title",
              message: "PR title:",
              validate: (v: string) => v.trim().length > 0 || "Title cannot be empty",
            },
          ]);
          prTitle = ans.title.trim();
        }

        // ── 7. Preview & confirm ───────────────────────────────────────────────
        logger.info("\n📋 Pull Request preview:\n");
        logger.info("─".repeat(60));
        logger.info(`  Title:  ${prTitle}`);
        logger.info(`  Branch: ${head} → ${base}`);
        if (prBody) {
          logger.info(`\n${prBody}`);
        }
        logger.info("─".repeat(60));

        if (options.dryRun) {
          logger.info("\n🔍 Dry run — PR not created.");
          return;
        }

        const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
          {
            type: "confirm",
            name: "confirmed",
            message: `Create${options.draft ? " draft" : ""} PR?`,
            default: true,
          },
        ]);

        if (!confirmed) {
          logger.info("Aborted — PR not created.");
          return;
        }

        // ── 8. Create PR ───────────────────────────────────────────────────────
        const createSpinner = ora("Creating pull request…").start();
        const createdPr = await provider.createPR(ctx.repoSlug, {
          title: prTitle,
          body: prBody,
          head,
          base,
          draft: options.draft,
        });
        createSpinner.stop();

        logger.success(`\n✅ PR created: ${createdPr.url}`);
        logger.info(`   #${createdPr.number} — ${createdPr.title}`);
      }
    );
}
