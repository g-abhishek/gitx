import type { Command } from "commander";
import inquirer from "inquirer";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { createProvider } from "../../../providers/factory.js";
import { GitHubProvider } from "../../../providers/github.js";
import {
  getCurrentBranch,
  getDefaultBranchFromGit,
  branchExistsOnRemote,
  pushBranch,
  isWorkingTreeDirty,
  hasStagedChanges,
  stageAll,
  commitChanges,
} from "../../../utils/gitOps.js";
import { GitxError } from "../../../utils/errors.js";

export function registerPrCreateCommand(pr: Command): void {
  pr.command("create")
    .description("🆕 Stage → commit → push → open a pull request in one step")
    .option("--title <title>", "PR title (prompted if omitted)")
    .option("--body <body>", "PR description (prompted if omitted)")
    .option("--message <message>", "Commit message (prompted if omitted)")
    .option("--base <base>", "Target / base branch (defaults to repo default)")
    .option("--draft", "Open as draft PR", false)
    .option("--ai-body", "Generate PR body via AI", false)
    .action(
      async (options: {
        title?: string;
        body?: string;
        message?: string;
        base?: string;
        draft: boolean;
        aiBody: boolean;
      }) => {
        const gitx = await Gitx.fromCwd();
        const ctx = await gitx.getRepoContext();
        const provider = createProvider(ctx);

        // ── Determine branches ────────────────────────────────────────────────
        const head = await getCurrentBranch(gitx.cwd);
        const defaultBase = await getDefaultBranchFromGit(gitx.cwd, gitx.config.defaultBranch);
        const base = options.base ?? (await provider.getDefaultBranch(ctx.repoSlug).catch(() => defaultBase));

        // ── Guard: cannot PR from a branch to itself ──────────────────────────
        if (head === base) {
          throw new GitxError(
            `You are on "${head}" which is also the base branch.\n` +
            `  Create a feature branch first:  git checkout -b my-feature`,
            { exitCode: 1 }
          );
        }

        logger.info(`\n🔀 ${ctx.repoSlug}  ·  ${head} → ${base}\n`);

        // ── Check for existing open PR (avoid duplicate) ──────────────────────
        if (provider instanceof GitHubProvider) {
          const existing = await provider.findExistingPR(ctx.repoSlug, head, base);
          if (existing) {
            logger.warn(`⚠️  An open PR already exists for this branch:`);
            logger.info(`   #${existing.number} — ${existing.title}`);
            logger.success(`   ${existing.url}`);
            return;
          }
        }

        // ── Stage & commit uncommitted changes ────────────────────────────────
        const dirty = await isWorkingTreeDirty(gitx.cwd);
        const staged = await hasStagedChanges(gitx.cwd);

        if (dirty || staged) {
          logger.info("📂 You have uncommitted changes — let's commit them first.\n");

          // Stage everything if not already staged
          if (dirty) {
            await stageAll(gitx.cwd);
            logger.info("   Staged all changes.");
          }

          // Get commit message
          let commitMsg = options.message;
          if (!commitMsg) {
            const ans = await inquirer.prompt<{ commitMsg: string }>([
              {
                type: "input",
                name: "commitMsg",
                message: "Commit message:",
                validate: (v: string) => v.trim().length > 0 || "Commit message cannot be empty",
              },
            ]);
            commitMsg = ans.commitMsg;
          }

          const sha = await commitChanges(commitMsg, gitx.cwd);
          logger.success(`   Committed: ${sha.slice(0, 8)}\n`);
        }

        // ── Push branch (create on remote if needed) ──────────────────────────
        const isOnRemote = await branchExistsOnRemote(head, gitx.cwd);
        if (!isOnRemote) {
          logger.info(`🚀 Pushing "${head}" to origin…`);
        } else {
          logger.info(`🚀 Pushing latest commits…`);
        }
        await pushBranch(head, gitx.cwd);
        logger.success(`   Pushed.\n`);

        // ── PR title ──────────────────────────────────────────────────────────
        let title = options.title;
        if (!title) {
          const ans = await inquirer.prompt<{ title: string }>([
            {
              type: "input",
              name: "title",
              message: "PR title:",
              validate: (v: string) => v.trim().length > 0 || "Title cannot be empty",
            },
          ]);
          title = ans.title;
        }

        // ── PR body ───────────────────────────────────────────────────────────
        let body = options.body ?? "";
        if (!body && options.aiBody) {
          if (!process.env["ANTHROPIC_API_KEY"]) {
            logger.warn("⚠️  ANTHROPIC_API_KEY not set — skipping AI body generation.");
          } else {
            logger.info("🧠 Generating PR body with AI…");
            const summary = await gitx.ai.summarizeChanges({ rawDiff: `Branch: ${head}` });
            body = summary.summary;
          }
        }
        if (!body) {
          const ans = await inquirer.prompt<{ body: string }>([
            {
              type: "input",
              name: "body",
              message: "PR description (leave blank to skip):",
              default: "",
            },
          ]);
          body = ans.body ?? "";
        }

        // ── Create PR ─────────────────────────────────────────────────────────
        logger.info("📬 Creating pull request…");
        const createdPr = await provider.createPR(ctx.repoSlug, {
          title,
          body,
          head,
          base,
          draft: options.draft,
        });

        logger.success(`\n✅ PR created: ${createdPr.url}`);
        logger.info(`   #${createdPr.number} — ${createdPr.title}`);
      }
    );
}
