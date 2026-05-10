/**
 * `gitx ask "<question>"` — Smart support assistant for your repo.
 *
 * Acts as a support agent that can answer three types of questions:
 *
 *  1. SETUP / DIAGNOSTIC — "is my AI provider set up?", "why isn't gitx working?",
 *       "do I have a GitHub token configured?"
 *     → Reads your live gitx config and reports real status (no fabrication).
 *
 *  2. REPO STATE — "what did I last commit?", "do I have unstaged changes?",
 *       "show me all open PRs"
 *     → Reads live git state (branch, commits, status, stashes).
 *
 *  3. HOW-TO — "how do I sync with main?", "how do I undo my last commit?",
 *       "what command creates a PR?"
 *     → Uses built-in gitx command reference embedded in every prompt.
 *
 * Examples:
 *   gitx ask "is my AI provider set up?"
 *   gitx ask "what did I last commit?"
 *   gitx ask "how do I sync my branch with main?"
 *   gitx ask "do I have any open PRs?" --pr
 *   gitx ask "why is gitx not working?"
 */

import type { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { Gitx } from "../../core/gitx.js";
import { logger } from "../../logger/logger.js";
import {
  getCurrentBranch,
  getGitStatus,
  getRecentCommits,
  getStashList,
} from "../../utils/gitOps.js";
import { isInsideGitRepo } from "../../utils/git.js";
import { createProvider } from "../../providers/factory.js";
import type { AiAskContext, AiSetupStatus, GitProviderStatus } from "../../ai/types.js";
import type { GitxConfig } from "../../types/config.js";

// ─── Config diagnostic helpers ────────────────────────────────────────────────

/**
 * Inspect the loaded config + environment variables and return a plain-English
 * snapshot of which AI provider is active — WITHOUT exposing actual key values.
 */
function buildAiSetupStatus(config: GitxConfig): AiSetupStatus {
  // 1. ANTHROPIC_API_KEY env var (highest priority)
  if (process.env["ANTHROPIC_API_KEY"]) {
    const model = process.env["GITX_AI_MODEL"] ?? config.aiProviders?.claude?.model ?? "claude-3-5-haiku-20241022";
    return {
      provider: "claude (Anthropic API)",
      model,
      keySource: "ANTHROPIC_API_KEY env var",
      isConfigured: true,
    };
  }

  // 2. OPENAI_API_KEY env var
  if (process.env["OPENAI_API_KEY"]) {
    const model = process.env["GITX_AI_MODEL"] ?? config.aiProviders?.openai?.model ?? "gpt-4o";
    return {
      provider: "openai",
      model,
      keySource: "OPENAI_API_KEY env var",
      isConfigured: true,
    };
  }

  // 3. defaultAiProvider in config
  const defaultProv = config.defaultAiProvider;
  if (defaultProv) {
    const entry = config.aiProviders?.[defaultProv];
    if (defaultProv === "claude-cli") {
      return {
        provider: "claude-cli (local)",
        keySource: "local CLI",
        isConfigured: true,
      };
    }
    if (entry?.apiKey) {
      const model = process.env["GITX_AI_MODEL"] ?? entry.model ?? (defaultProv === "claude" ? "claude-3-5-haiku-20241022" : "gpt-4o");
      return {
        provider: defaultProv === "claude" ? "claude (Anthropic API)" : defaultProv,
        model,
        keySource: "config file",
        isConfigured: true,
      };
    }
    // defaultAiProvider set but key is missing
    return {
      provider: `${defaultProv} (key missing)`,
      keySource: "config file (key missing — needs to be set)",
      isConfigured: false,
    };
  }

  // 4. Scan all aiProviders entries
  const entries = Object.entries(config.aiProviders ?? {}) as Array<[string, { apiKey?: string; model?: string }]>;
  for (const [kind, entry] of entries) {
    if (kind === "claude-cli") {
      return {
        provider: "claude-cli (local)",
        keySource: "config file",
        isConfigured: true,
      };
    }
    if (entry?.apiKey) {
      const model = process.env["GITX_AI_MODEL"] ?? entry.model;
      return {
        provider: kind === "claude" ? "claude (Anthropic API)" : kind,
        model,
        keySource: "config file",
        isConfigured: true,
      };
    }
  }

  // 5. No provider found
  return {
    provider: "none (not configured)",
    keySource: "none",
    isConfigured: false,
  };
}

/**
 * Return the list of configured git hosting providers with a simple
 * "has token / missing token" status. Never exposes actual token values.
 */
function buildGitProviderStatus(config: GitxConfig): GitProviderStatus[] {
  const providers = config.providers ?? {};
  const result: GitProviderStatus[] = [];
  for (const [name, entry] of Object.entries(providers)) {
    result.push({
      name,
      hasToken: !!entry?.token && entry.token.length > 0,
    });
  }
  return result;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerAskCommand(program: Command): void {
  program
    .command("ask")
    .description("💬 Ask a question about your repo or gitx setup using AI")
    .argument("<question>", "Your question (wrap in quotes for multi-word questions)")
    .option("--pr", "Include open pull requests in the context (requires a provider token)")
    .option("--no-color", "Disable colored output")
    .action(async (question: string, options: { pr?: boolean }) => {
      const cwd = process.cwd();
      const gitx = await Gitx.fromCwd(cwd);

      // ── 1. Build gitx setup diagnostics ───────────────────────────────────
      const aiSetup = buildAiSetupStatus(gitx.config);
      const gitProviders = buildGitProviderStatus(gitx.config);
      const defaultBranch = gitx.config.defaultBranch;

      // ── 2. Gather live git context ─────────────────────────────────────────
      const contextSpinner = ora("🔍 Gathering context…").start();

      let inRepo = false;
      let currentBranch = "unknown";
      let gitStatus = "";
      let recentCommits: string[] = [];
      let stashes: string[] = [];

      try {
        inRepo = await isInsideGitRepo(cwd);

        if (inRepo) {
          [currentBranch, gitStatus, recentCommits, stashes] = await Promise.all([
            getCurrentBranch(cwd),
            getGitStatus(cwd),
            getRecentCommits(cwd, 10),
            getStashList(cwd),
          ]);
        }
        contextSpinner.succeed("Context gathered.");
      } catch {
        contextSpinner.warn("Could not read full git context — proceeding with partial info.");
      }

      const context: AiAskContext = {
        isInsideGitRepo: inRepo,
        currentBranch,
        recentCommits,
        gitStatus,
        stashes: stashes.length > 0 ? stashes : undefined,
        aiSetup,
        gitProviders,
        defaultBranch,
      };

      // ── 3. Optionally fetch open PRs ───────────────────────────────────────
      const mentionsPR = /\bpr\b|pull request/i.test(question);
      if (options.pr || mentionsPR) {
        const prSpinner = ora("📋 Fetching open PRs…").start();
        try {
          const repoCtx = await gitx.getRepoContext();
          const provider = createProvider(repoCtx);
          const allPRs = await provider.listPRs(repoCtx.repoSlug);
          const prs = allPRs.filter((pr) => pr.state === "open");
          context.openPRs = prs.map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            branch: pr.head,
          }));
          prSpinner.succeed(`Found ${prs.length} open PR${prs.length !== 1 ? "s" : ""}.`);
        } catch {
          prSpinner.warn("Could not fetch PRs — provider token may not be configured.");
        }
      }

      // ── 4. Ask AI ──────────────────────────────────────────────────────────
      const aiSpinner = ora("🤖 Thinking…").start();
      let answer = "";
      let suggestedCommands: string[] = [];

      try {
        const result = await gitx.ai.ask(question, context);
        answer = result.answer;
        suggestedCommands = result.suggestedCommands ?? [];
        aiSpinner.succeed("Answer ready.");
      } catch (err) {
        aiSpinner.fail("AI query failed.");
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      // ── 5. Display answer ──────────────────────────────────────────────────
      console.log("");
      console.log(chalk.bold.cyan("╭─ gitx ask ─────────────────────────────────────────"));
      console.log(chalk.gray("│  Q: ") + chalk.white(question));
      console.log(chalk.bold.cyan("│"));
      answer.split("\n").forEach((line) => {
        console.log(chalk.bold.cyan("│") + "  " + line);
      });

      if (suggestedCommands.length > 0) {
        console.log(chalk.bold.cyan("│"));
        console.log(chalk.bold.cyan("│") + "  " + chalk.yellow.bold("💡 Suggested commands:"));
        suggestedCommands.forEach((cmd) => {
          console.log(chalk.bold.cyan("│") + "    " + chalk.green(`$ ${cmd}`));
        });
      }

      console.log(chalk.bold.cyan("╰────────────────────────────────────────────────────"));
      console.log("");
    });
}
