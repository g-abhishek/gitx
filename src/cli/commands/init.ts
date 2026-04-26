import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../logger/logger.js";
import { saveConfig } from "../../config/config.js";
import type { GitxConfig } from "../../types/config.js";
import type { ProviderKind } from "../../types/provider.js";
import { validateNonEmpty, validateOptionalRepoSlug } from "../../utils/validators.js";
import { resolveRepoSlugFromCwd } from "../../utils/git.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("🚀 Initialize gitx configuration")
    .action(async () => {
      logger.info("📄 gitx init");

      const inferredRepo = await resolveRepoSlugFromCwd();

      const answers = await inquirer.prompt<{
        provider: ProviderKind;
        token: string;
        repo: string;
        defaultBranch: string;
      }>([
        {
          type: "list",
          name: "provider",
          message: "Choose a Git provider",
          choices: [
            { name: "GitHub", value: "github" },
            { name: "GitLab", value: "gitlab" },
            { name: "Azure DevOps", value: "azure" }
          ]
        },
        {
          type: "password",
          name: "token",
          message: "Enter an access token",
          mask: "*",
          validate: validateNonEmpty("Token")
        },
        {
          type: "input",
          name: "repo",
          message: "Repo (optional; e.g. owner/name). Leave blank to infer from current git repo.",
          default: inferredRepo,
          validate: validateOptionalRepoSlug
        },
        {
          type: "input",
          name: "defaultBranch",
          message: "Default branch",
          default: "main",
          validate: validateNonEmpty("Default branch")
        }
      ]);

      const repo = answers.repo.trim().length > 0 ? answers.repo.trim() : undefined;

      const config: GitxConfig = {
        provider: answers.provider,
        token: answers.token,
        ...(repo ? { repo } : {}),
        defaultBranch: answers.defaultBranch
      };

      const spinner = ora("Saving config…").start();
      await saveConfig(config);
      spinner.succeed("Config saved");

      logger.success("✅ gitx is ready");
      logger.info("Next: run `gitx implement \"<task>\" --mode=plan`");
    });
}
