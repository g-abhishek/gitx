import type { Command } from "commander";
import { logger } from "../../../logger/logger.js";
import { Gitx } from "../../../core/gitx.js";
import { createProvider } from "../../../providers/factory.js";
import type { PullRequest } from "../../../providers/base.js";

export function registerPrListCommand(pr: Command): void {
  pr.command("list")
    .description("📋 List open pull requests")
    .option("--state <state>", "Filter: open|closed|all", "open")
    .action(async (options: { state: string }) => {
      const gitx = await Gitx.fromCwd();
      const ctx = await gitx.getRepoContext();

      logger.info(`📋 Fetching PRs for ${ctx.repoSlug} (${ctx.provider})…`);

      const provider = createProvider(ctx);
      const prs: PullRequest[] = await provider.listPRs(ctx.repoSlug);

      const filtered =
        options.state === "all"
          ? prs
          : prs.filter((p) => p.state === options.state);

      if (filtered.length === 0) {
        logger.info(`No ${options.state} pull requests found.`);
        return;
      }

      logger.info(`\nFound ${filtered.length} pull request(s):\n`);
      for (const p of filtered) {
        const stateIcon = p.state === "open" ? "🟢" : p.state === "merged" ? "🟣" : "🔴";
        logger.info(
          `  ${stateIcon} #${p.number}  ${p.title}`
        );
        logger.info(`        Branch: ${p.head} → ${p.base}`);
        logger.info(`        Author: ${p.author}  |  Updated: ${new Date(p.updatedAt).toLocaleDateString()}`);
        logger.info(`        URL:    ${p.url}`);
        logger.info("");
      }
    });
}
