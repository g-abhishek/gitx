import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../logger/logger.js";
import type { GitxConfig } from "../../types/config.js";
import type { ProviderKind } from "../../types/provider.js";
import { findConfigPath, loadConfig, saveConfig } from "../../config/config.js";
import { GitxError } from "../../utils/errors.js";
import { validateNonEmpty } from "../../utils/validators.js";

function redactConfig(config: GitxConfig): unknown {
  const providers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config.providers)) {
    providers[k] = v?.token ? { token: "***" } : {};
  }
  return { ...config, providers };
}

function parseProvider(value: string): ProviderKind {
  if (value === "github" || value === "gitlab" || value === "azure") return value;
  throw new GitxError("Invalid provider. Use github|gitlab|azure.", { exitCode: 2 });
}

async function loadOrEmptyConfig(): Promise<GitxConfig> {
  try {
    return await loadConfig(process.cwd());
  } catch (e) {
    if (e instanceof GitxError) {
      return { providers: {} };
    }
    throw e;
  }
}

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("⚙️ Configure gitx");

  config
    .command("show")
    .description("🔍 Show current gitx config (tokens redacted)")
    .action(async () => {
      const existing = await loadConfig(process.cwd());
      logger.info(`📍 Loaded from: ${(await findConfigPath(process.cwd())) ?? "unknown"}`);
      logger.info(JSON.stringify(redactConfig(existing), null, 2));
    });

  config
    .command("set-provider")
    .description("🔐 Add/update provider token")
    .argument("<provider>", "github|gitlab|azure")
    .argument("[token]", "Access token (optional; will prompt if omitted)")
    .action(async (providerRaw: string, tokenArg?: string) => {
      const provider = parseProvider(providerRaw);

      const existing = await loadOrEmptyConfig();

      const token =
        tokenArg?.trim().length
          ? tokenArg.trim()
          : (
              await inquirer.prompt<{ token: string }>([
                {
                  type: "password",
                  name: "token",
                  message: `Token for ${provider}`,
                  mask: "*",
                  validate: validateNonEmpty("Token")
                }
              ])
            ).token;

      const updated: GitxConfig = {
        ...existing,
        providers: { ...existing.providers, [provider]: { token } }
      };

      const spinner = ora("Saving config…").start();
      const savedPath = await saveConfig(updated);
      spinner.succeed("Config saved");
      logger.info(`🧾 Saved: ${savedPath}`);
      logger.success(`✅ Provider updated: ${provider}`);
    });

  config
    .command("set-default-branch")
    .description("🌿 Set default branch")
    .argument("<branch>", "Branch name (e.g. main)")
    .action(async (branch: string) => {
      const ok = validateNonEmpty("Default branch")(branch);
      if (ok !== true) throw new GitxError(String(ok), { exitCode: 2 });

      const existing = await loadOrEmptyConfig();
      const updated: GitxConfig = { ...existing, defaultBranch: branch.trim() };

      const spinner = ora("Saving config…").start();
      const savedPath = await saveConfig(updated);
      spinner.succeed("Config saved");
      logger.info(`🧾 Saved: ${savedPath}`);
      logger.success("✅ Default branch updated");
    });
}

