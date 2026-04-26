import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../logger/logger.js";
import { getGlobalConfigPath, saveConfig } from "../../config/config.js";
import type { GitxConfig } from "../../types/config.js";
import type { ProviderKind } from "../../types/provider.js";
import { validateNonEmpty } from "../../utils/validators.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("🚀 Initialize gitx configuration")
    .action(async () => {
      logger.info("📄 gitx init");

      type InitAnswers = {
        provider: ProviderKind;
        token: string;
        defaultBranch: string;
      };

      const questions = [
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
          message: "Access token",
          mask: "*",
          validate: validateNonEmpty("Token")
        },
        {
          type: "input",
          name: "defaultBranch",
          message: "Default branch",
          default: "main",
          validate: validateNonEmpty("Default branch")
        }
      ];

      // Inquirer question typings are strict across versions; keep runtime behavior, relax TS here.
      const answers = await inquirer.prompt<InitAnswers>(questions as any);

      const config: GitxConfig = {
        providers: {
          [answers.provider]: { token: answers.token }
        },
        defaultBranch: answers.defaultBranch
      };

      const spinner = ora("Saving config…").start();
      await saveConfig(config);
      spinner.succeed("Config saved");
      logger.info(`🧾 Saved: ${getGlobalConfigPath()}`);

      logger.success("✅ gitx is ready");
      logger.info("Next: run `gitx implement \"<task>\" --mode=plan` inside a git repo");
    });
}
