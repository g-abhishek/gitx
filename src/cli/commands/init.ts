import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../logger/logger.js";
import { saveConfig } from "../../config/config.js";
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
        providers: ProviderKind[];
        githubToken?: string;
        gitlabToken?: string;
        azureToken?: string;
        defaultBranch: string;
      };

      const questions = [
        {
          type: "checkbox",
          name: "providers",
          message: "Choose provider(s) to configure",
          choices: [
            { name: "GitHub", value: "github" },
            { name: "GitLab", value: "gitlab" },
            { name: "Azure DevOps", value: "azure" }
          ],
          validate: (value: ProviderKind[]) => (Array.isArray(value) && value.length > 0 ? true : "Select at least one provider")
        },
        {
          type: "password",
          name: "githubToken",
          message: "GitHub token",
          mask: "*",
          validate: validateNonEmpty("GitHub token"),
          when: (a: InitAnswers) => a.providers.includes("github")
        },
        {
          type: "password",
          name: "gitlabToken",
          message: "GitLab token",
          mask: "*",
          validate: validateNonEmpty("GitLab token"),
          when: (a: InitAnswers) => a.providers.includes("gitlab")
        },
        {
          type: "password",
          name: "azureToken",
          message: "Azure DevOps token (PAT)",
          mask: "*",
          validate: validateNonEmpty("Azure DevOps token"),
          when: (a: InitAnswers) => a.providers.includes("azure")
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

      const providers: GitxConfig["providers"] = {};
      if (answers.githubToken) providers.github = { token: answers.githubToken };
      if (answers.gitlabToken) providers.gitlab = { token: answers.gitlabToken };
      if (answers.azureToken) providers.azure = { token: answers.azureToken };

      const config: GitxConfig = {
        providers,
        defaultBranch: answers.defaultBranch
      };

      const spinner = ora("Saving config…").start();
      await saveConfig(config);
      spinner.succeed("Config saved");

      logger.success("✅ gitx is ready");
      logger.info("Next: run `gitx implement \"<task>\" --mode=plan` inside a git repo");
    });
}
