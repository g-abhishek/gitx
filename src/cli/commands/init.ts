import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../logger/logger.js";
import { getConfigPath, loadConfig, saveConfig } from "../../config/config.js";
import type { GitxConfig } from "../../types/config.js";
import type { ProviderKind } from "../../types/provider.js";
import { validateNonEmpty } from "../../utils/validators.js";
import { GitxError } from "../../utils/errors.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("🚀 Initialize gitx configuration")
    .action(async () => {
      logger.info("📄 gitx init\n");

      // ── Load existing config (if any) so we can MERGE, not overwrite ─────
      let existing: GitxConfig = { providers: {} };
      try {
        existing = await loadConfig();
        const providerList = Object.keys(existing.providers).join(", ");
        logger.info(`Existing config found with providers: ${providerList}`);
        logger.info("Any new values you enter will be merged in.\n");
      } catch {
        // No config yet — starting fresh
      }

      type InitAnswers = {
        provider: ProviderKind;
        token: string;
        defaultBranch: string;
      };

      const answers = await inquirer.prompt<InitAnswers>([
        {
          type: "list",
          name: "provider",
          message: "Choose a Git provider to configure",
          choices: [
            { name: "GitHub", value: "github" },
            { name: "GitLab", value: "gitlab" },
            { name: "Azure DevOps", value: "azure" },
          ],
        },
        {
          type: "password",
          name: "token",
          message: "Access token",
          mask: "*",
          validate: validateNonEmpty("Token"),
        },
        {
          type: "input",
          name: "defaultBranch",
          message: "Default base branch",
          default: existing.defaultBranch ?? "main",
          validate: validateNonEmpty("Default branch"),
        },
      ] as any);

      // Merge new provider into existing providers (preserves other providers)
      const merged: GitxConfig = {
        providers: {
          ...existing.providers,
          [answers.provider]: { token: answers.token },
        },
        defaultBranch: answers.defaultBranch,
      };

      const spinner = ora("Saving config…").start();
      const savedPath = await saveConfig(merged);
      spinner.succeed("Config saved");
      logger.info(`🧾 Saved: ${savedPath}`);

      const allProviders = Object.keys(merged.providers).join(", ");
      logger.success(`\n✅ gitx is ready  (providers: ${allProviders})`);
      logger.info('Next: run `gitx implement "<task>" --mode=plan` inside a git repo');

      if (!process.env["ANTHROPIC_API_KEY"]) {
        logger.warn(
          "\n⚠️  ANTHROPIC_API_KEY is not set — AI features will return placeholder data.\n" +
          "   Export it to enable real AI: export ANTHROPIC_API_KEY=sk-ant-..."
        );
      }
    });
}
