import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { logger } from "../../logger/logger.js";
import type { GitxConfig, AiProviderKind } from "../../types/config.js";
import type { ProviderKind } from "../../types/provider.js";
import { loadConfig, saveConfig, getConfigPath } from "../../config/config.js";
import { GitxError } from "../../utils/errors.js";
import { validateNonEmpty } from "../../utils/validators.js";
import { Gitx } from "../../core/gitx.js";
import { ClaudeCliAi } from "../../ai/claudeCliAi.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const GIT_PROVIDERS = ["github", "gitlab", "azure"] as const;
const AI_PROVIDERS = ["claude", "openai", "claude-cli"] as const;

type GitProviderKey = typeof GIT_PROVIDERS[number];
type AiProviderKey = typeof AI_PROVIDERS[number];

function isGitProvider(key: string): key is GitProviderKey {
  return (GIT_PROVIDERS as readonly string[]).includes(key);
}

function isAiProvider(key: string): key is AiProviderKey {
  return (AI_PROVIDERS as readonly string[]).includes(key);
}

async function loadOrEmpty(): Promise<GitxConfig> {
  try {
    return await loadConfig();
  } catch {
    return { providers: {} };
  }
}

function redactConfig(config: GitxConfig): unknown {
  const providers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config.providers)) {
    providers[k] = v?.token ? { token: v.token.slice(0, 6) + "***" } : {};
  }
  const aiProviders: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config.aiProviders ?? {})) {
    aiProviders[k] = k === "claude-cli"
      ? { type: "local CLI" }
      : { apiKey: v?.apiKey ? v.apiKey.slice(0, 6) + "***" : "(none)", ...(v?.model ? { model: v.model } : {}) };
  }
  return {
    ...config,
    providers,
    ...(Object.keys(aiProviders).length ? { aiProviders } : {}),
    ai: undefined,
  };
}

// ─── Register command ─────────────────────────────────────────────────────────

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("⚙️  Configure gitx (runs setup wizard when called with no subcommand)")
    .action(async () => {
      // `gitx config` with no subcommand → run the setup wizard
      await runSetup();
    });

  // ── gitx config show ───────────────────────────────────────────────────────
  config
    .command("show")
    .description("🔍 Show current gitx config")
    .action(async () => {
      let cfg: GitxConfig;
      try {
        cfg = await loadConfig();
      } catch {
        logger.warn("No config found. Run `gitx config` to get started.");
        return;
      }

      // Auto-detect current repo provider
      const gitx = await Gitx.fromCwd().catch(() => null);
      const detected = gitx ? await gitx.detectProvider().catch(() => null) : null;
      if (detected) {
        logger.info(`🔎 Current repo: ${detected.repoSlug}  (${detected.provider})`);
        const hasToken = Boolean(cfg.providers[detected.provider as ProviderKind]?.token);
        hasToken
          ? logger.success(`   ${detected.provider} token: configured ✓`)
          : logger.warn(`   ${detected.provider} token: NOT configured — run: gitx config set ${detected.provider}`);
      }

      // Show all AI providers
      logger.info("\n🤖 AI Providers:");
      const aiEntries = Object.entries(cfg.aiProviders ?? {}) as Array<[AiProviderKind, { apiKey?: string; model?: string }]>;
      if (aiEntries.length === 0) {
        logger.warn("   none configured — run: gitx config set claude|openai|claude-cli");
      } else {
        for (const [kind] of aiEntries) {
          const isDefault = cfg.defaultAiProvider === kind;
          const marker = isDefault ? " (default)" : "";
          if (kind === "claude-cli") {
            const available = await ClaudeCliAi.isAvailable();
            logger.info(`   ${isDefault ? "✓" : "○"} claude-cli${marker} — ${available ? "installed ✓" : "not detected ✗"}`);
          } else {
            logger.info(`   ${isDefault ? "✓" : "○"} ${kind}${marker}`);
          }
        }
      }

      logger.info(`\n📍 Config file: ${getConfigPath()}`);
      logger.info(JSON.stringify(redactConfig(cfg), null, 2));
    });

  // ── gitx config set <KEY> [value] ─────────────────────────────────────────
  // KEY = github | gitlab | azure | claude | openai | claude-cli
  config
    .command("set")
    .description(
      "🔑 Set a provider token or AI key (also sets it as the default AI)\n" +
      "  Git: gitx config set github|gitlab|azure [token]\n" +
      "  AI:  gitx config set claude|openai [apiKey]\n" +
      "       gitx config set claude-cli"
    )
    .argument("<key>", "Provider: github | gitlab | azure | claude | openai | claude-cli")
    .argument("[value]", "Token or API key (prompted if omitted; not needed for claude-cli)")
    .action(async (key: string, valueArg?: string) => {
      if (isGitProvider(key)) {
        await setGitProvider(key, valueArg);
      } else if (isAiProvider(key)) {
        await setAiProvider(key, valueArg);
      } else {
        throw new GitxError(
          `Unknown key: "${key}". Use one of: github, gitlab, azure, claude, openai, claude-cli`,
          { exitCode: 2 }
        );
      }
    });

  // ── gitx config set-default-ai [provider] ────────────────────────────────
  config
    .command("set-default-ai")
    .description("⭐ Switch which AI provider gitx uses by default")
    .argument("[provider]", "AI provider to set as default (prompted if omitted)")
    .action(async (providerArg?: string) => {
      await setDefaultAi(providerArg);
    });

  // ── gitx config set-default-branch <branch> ──────────────────────────────
  config
    .command("set-default-branch")
    .description("🌿 Set default base branch")
    .argument("<branch>", "Branch name (e.g. main)")
    .action(async (branch: string) => {
      const ok = validateNonEmpty("Default branch")(branch);
      if (ok !== true) throw new GitxError(String(ok), { exitCode: 2 });

      const existing = await loadOrEmpty();
      const updated: GitxConfig = { ...existing, defaultBranch: branch.trim() };
      const spinner = ora("Saving…").start();
      const path = await saveConfig(updated);
      spinner.succeed(`Saved to ${path}`);
      logger.success("✅ Default branch updated.");
    });
}

// ─── Set git provider ─────────────────────────────────────────────────────────

async function setGitProvider(provider: GitProviderKey, tokenArg?: string): Promise<void> {
  const existing = await loadOrEmpty();

  const hints: Record<GitProviderKey, string> = {
    github: "github.com/settings/tokens → New token → scope: repo",
    gitlab: "gitlab.com/-/profile/personal_access_tokens → scope: api",
    azure: "dev.azure.com → User settings → Personal access tokens → scope: Code (Read & write)",
  };
  logger.info(`   ℹ️  Get a token at: ${hints[provider]}\n`);

  const token = tokenArg?.trim().length
    ? tokenArg.trim()
    : (await inquirer.prompt<{ token: string }>([
        {
          type: "password",
          name: "token",
          message: `Token for ${provider}:`,
          mask: "*",
          validate: validateNonEmpty("Token"),
        },
      ])).token;

  const updated: GitxConfig = {
    ...existing,
    providers: { ...existing.providers, [provider]: { token } },
  };

  const spinner = ora("Saving…").start();
  const path = await saveConfig(updated);
  spinner.succeed(`Saved to ${path}`);
  logger.success(`✅ ${provider} token updated.`);
}

// ─── Set AI provider ──────────────────────────────────────────────────────────

async function setAiProvider(aiProvider: AiProviderKey, keyArg?: string): Promise<void> {
  const existing = await loadOrEmpty();

  if (aiProvider === "claude-cli") {
    // No key needed — just detect and register
    const spinner = ora("Checking for local Claude CLI…").start();
    const available = await ClaudeCliAi.isAvailable();
    if (!available) {
      spinner.fail("claude-cli not found on PATH.");
      logger.warn("Install Claude Code from https://claude.ai/download and try again.");
      return;
    }
    spinner.succeed("claude-cli detected ✓");

    const updated: GitxConfig = {
      ...existing,
      aiProviders: { ...(existing.aiProviders ?? {}), "claude-cli": {} },
      defaultAiProvider: "claude-cli",
    };
    const savePath = await saveConfig(updated);
    logger.success(`✅ claude-cli set as default AI. (saved to ${savePath})`);
    return;
  }

  // claude / openai — need an API key
  const hints: Record<string, string> = {
    claude: "console.anthropic.com → API Keys",
    openai: "platform.openai.com → API keys",
  };
  logger.info(`   ℹ️  Get a key at: ${hints[aiProvider]}\n`);

  const apiKey = keyArg?.trim().length
    ? keyArg.trim()
    : (await inquirer.prompt<{ apiKey: string }>([
        {
          type: "password",
          name: "apiKey",
          message: `API key for ${aiProvider}:`,
          mask: "*",
          validate: validateNonEmpty("API key"),
        },
      ])).apiKey;

  const updated: GitxConfig = {
    ...existing,
    aiProviders: {
      ...(existing.aiProviders ?? {}),
      [aiProvider]: {
        ...(existing.aiProviders?.[aiProvider] ?? {}),
        apiKey,
      },
    },
    defaultAiProvider: aiProvider as AiProviderKind,
  };

  const spinner = ora("Saving…").start();
  const path = await saveConfig(updated);
  spinner.succeed(`Saved to ${path}`);
  logger.success(`✅ ${aiProvider} configured and set as default AI provider.`);
  logger.info("   Note: ANTHROPIC_API_KEY env var always overrides stored keys.");
}

// ─── Switch default AI ────────────────────────────────────────────────────────

async function setDefaultAi(providerArg?: string): Promise<void> {
  const existing = await loadOrEmpty();
  const configured = Object.keys(existing.aiProviders ?? {}) as AiProviderKey[];

  if (configured.length === 0) {
    logger.warn("No AI providers configured yet.");
    logger.info("Run `gitx config set claude|openai|claude-cli` to add one.");
    return;
  }

  let chosen: AiProviderKind;

  if (providerArg && isAiProvider(providerArg)) {
    if (!configured.includes(providerArg as AiProviderKey)) {
      logger.warn(`"${providerArg}" is not yet configured. Run: gitx config set ${providerArg}`);
      return;
    }
    chosen = providerArg as AiProviderKind;
  } else if (configured.length === 1) {
    // Only one provider — set it silently, no need to ask
    chosen = configured[0] as AiProviderKind;
    logger.info(`Only one AI provider configured — setting "${chosen}" as default.`);
  } else {
    // Multiple providers — show a picker
    const choices = await Promise.all(
      configured.map(async (k) => {
        let suffix = "";
        if (k === "claude-cli") {
          const avail = await ClaudeCliAi.isAvailable();
          suffix = avail ? " (installed ✓)" : " (not detected ✗)";
        }
        const isDefault = existing.defaultAiProvider === k;
        return {
          name: `${k}${suffix}${isDefault ? "  ← current default" : ""}`,
          value: k as AiProviderKind,
        };
      })
    );

    const result = await inquirer.prompt<{ provider: AiProviderKind }>([
      {
        type: "list",
        name: "provider",
        message: "Which AI provider should be the default?",
        choices,
        default: existing.defaultAiProvider,
      },
    ]);
    chosen = result.provider;
  }

  const updated: GitxConfig = { ...existing, defaultAiProvider: chosen };
  const spinner = ora("Saving…").start();
  const path = await saveConfig(updated);
  spinner.succeed(`Saved to ${path}`);
  logger.success(`✅ Default AI provider set to: ${chosen}`);
}

// ─── Setup wizard ─────────────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  logger.info("🚀 gitx setup\n");

  // Detect current repo git provider
  let detectedProvider: string | undefined;
  try {
    const gitx = await Gitx.fromCwd();
    const det = await gitx.detectProvider();
    if (det) {
      detectedProvider = det.provider;
      logger.info(`🔎 Detected repo provider: ${det.provider} (${det.repoSlug})\n`);
    }
  } catch { /* not in a git repo */ }

  const existing = await loadOrEmpty();
  const cliAvail = await ClaudeCliAi.isAvailable();

  // ── Step 1: Git provider ─────────────────────────────────────────────────
  logger.info("── Step 1 of 2: Git provider\n");

  const hasAnyGitProvider = Object.values(existing.providers).some((v) => v?.token);

  const gitChoices = [
    { name: "GitHub", value: "github" as ProviderKind },
    { name: "GitLab", value: "gitlab" as ProviderKind },
    { name: "Azure DevOps", value: "azure" as ProviderKind },
  ];

  // Annotate already-configured providers
  const annotatedGitChoices = gitChoices.map((c) => {
    const hasToken = Boolean(existing.providers[c.value]?.token);
    return hasToken ? { ...c, name: `${c.name}  ✓ already configured` } : c;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any[];

  // Only show Skip if at least one provider is already configured
  if (hasAnyGitProvider) {
    annotatedGitChoices.push(new inquirer.Separator());
    annotatedGitChoices.push({ name: "Skip — keep existing git config", value: "skip" });
  }

  const { providerOrSkip } = await inquirer.prompt<{ providerOrSkip: ProviderKind | "skip" }>([
    {
      type: "list",
      name: "providerOrSkip",
      message: hasAnyGitProvider
        ? "Which git provider? (select Skip to leave unchanged)"
        : "Which git provider is this repo on?",
      choices: annotatedGitChoices,
      default: detectedProvider ?? "github",
    },
  ]);

  const providerHints: Record<ProviderKind, string> = {
    github: "github.com/settings/tokens → New token → scope: repo",
    gitlab: "gitlab.com/-/profile/personal_access_tokens → scope: api",
    azure: "dev.azure.com → User settings → Personal access tokens → scope: Code (Read & write)",
  };

  // Track what to save for git providers
  let updatedProviders = existing.providers;

  if (providerOrSkip === "skip") {
    logger.info("   Skipping git provider setup — existing config unchanged.\n");
  } else {
    const provider = providerOrSkip;
    const existingToken = existing.providers[provider]?.token;

    if (existingToken) {
      // Already configured — show masked value and ask to keep or replace
      const masked = existingToken.slice(0, 6) + "•".repeat(Math.min(existingToken.length - 6, 20));
      logger.info(`   ✓ ${provider} token already configured: ${masked}`);

      const { replaceToken } = await inquirer.prompt<{ replaceToken: boolean }>([
        {
          type: "confirm",
          name: "replaceToken",
          message: `Replace the existing ${provider} token?`,
          default: false,
        },
      ]);

      if (replaceToken) {
        logger.info(`   ℹ️  Get a token at: ${providerHints[provider]}\n`);
        const answer = await inquirer.prompt<{ token: string }>([
          {
            type: "password",
            name: "token",
            message: `New ${provider} access token:`,
            mask: "*",
            validate: validateNonEmpty("Token"),
          },
        ]);
        updatedProviders = { ...existing.providers, [provider]: { token: answer.token } };
      } else {
        logger.info("   Keeping existing token.\n");
        // updatedProviders already has existing.providers, no change needed
      }
    } else {
      logger.info(`   ℹ️  Get a token at: ${providerHints[provider]}\n`);
      const answer = await inquirer.prompt<{ token: string }>([
        {
          type: "password",
          name: "token",
          message: `${provider} access token:`,
          mask: "*",
          validate: validateNonEmpty("Token"),
        },
      ]);
      updatedProviders = { ...existing.providers, [provider]: { token: answer.token } };
    }
  }

  // ── Step 2: AI provider ──────────────────────────────────────────────────
  logger.info("\n── Step 2 of 2: AI provider\n");

  if (cliAvail) logger.info("   ✓ Claude CLI detected on your system.\n");

  const { setupAi } = await inquirer.prompt<{ setupAi: boolean }>([
    {
      type: "confirm",
      name: "setupAi",
      message: "Configure an AI provider? (needed for implement, review, fix-comments)",
      default: true,
    },
  ]);

  let newAiProviders: GitxConfig["aiProviders"] = existing.aiProviders ?? {};
  let newDefaultAi: AiProviderKind | undefined = existing.defaultAiProvider;

  if (setupAi) {
    // Annotate already-configured AI providers
    const aiChoices = [
      ...(cliAvail
        ? [{ name: `Claude CLI (free, uses your Claude login)${existing.aiProviders?.["claude-cli"] ? "  ✓ already configured" : " ← detected!"}`, value: "claude-cli" as AiProviderKind }]
        : [{ name: "Claude CLI (not detected — install Claude Code first)", value: "claude-cli" as AiProviderKind, disabled: true }]
      ),
      {
        name: `Claude API (Anthropic)${existing.aiProviders?.["claude"] ? "  ✓ already configured" : " — recommended for CI/CD"}`,
        value: "claude" as AiProviderKind,
      },
      {
        name: `OpenAI (GPT-4o)${existing.aiProviders?.["openai"] ? "  ✓ already configured" : ""}`,
        value: "openai" as AiProviderKind,
      },
      new inquirer.Separator(),
      { name: "Skip — keep existing AI config", value: "skip" as unknown as AiProviderKind },
    ];

    const { aiProvider } = await inquirer.prompt<{ aiProvider: AiProviderKind | "skip" }>([
      {
        type: "list",
        name: "aiProvider",
        message: "AI provider: (select Skip to leave unchanged)",
        choices: aiChoices,
        default: cliAvail ? "claude-cli" : (existing.defaultAiProvider ?? "claude"),
      },
    ]);

    if (aiProvider === "skip") {
      logger.info("   Skipping AI provider setup — existing AI config unchanged.\n");
      // newAiProviders and newDefaultAi stay as their current values, fall through to save
    } else if (aiProvider === "claude-cli") {
      // Claude CLI — no key needed
      if (existing.aiProviders?.["claude-cli"]) {
        logger.info("   ✓ Claude CLI already configured — keeping as is.\n");
      } else {
        logger.success("   Using Claude CLI — no API key needed.\n");
      }
      newAiProviders = { ...newAiProviders, "claude-cli": {} };
      newDefaultAi = "claude-cli";

    } else if (aiProvider === "claude" || aiProvider === "openai") {
      const hints: Record<string, string> = {
        claude: "console.anthropic.com → API Keys",
        openai: "platform.openai.com → API keys",
      };
      const existingKey = existing.aiProviders?.[aiProvider]?.apiKey;

      if (existingKey) {
        // Already configured — show masked and ask to keep or replace
        const maskedKey = existingKey.slice(0, 10) + "•".repeat(Math.min(existingKey.length - 10, 20));
        logger.info(`   ✓ ${aiProvider} API key already configured: ${maskedKey}`);

        const { replaceKey } = await inquirer.prompt<{ replaceKey: boolean }>([
          {
            type: "confirm",
            name: "replaceKey",
            message: `Replace the existing ${aiProvider} API key?`,
            default: false,
          },
        ]);

        if (replaceKey) {
          logger.info(`   ℹ️  Get a key at: ${hints[aiProvider]}\n`);
          const answer = await inquirer.prompt<{ apiKey: string }>([
            {
              type: "password",
              name: "apiKey",
              message: `New ${aiProvider} API key (leave blank to skip):`,
              mask: "*",
            },
          ]);
          if (!answer.apiKey.trim()) {
            logger.info("   Skipping — keeping existing key.\n");
            newAiProviders = { ...newAiProviders, [aiProvider]: { ...(newAiProviders?.[aiProvider] ?? {}), apiKey: existingKey } };
          } else {
            newAiProviders = { ...newAiProviders, [aiProvider]: { ...(newAiProviders?.[aiProvider] ?? {}), apiKey: answer.apiKey } };
            newDefaultAi = aiProvider;
          }
        } else {
          logger.info("   Keeping existing key.\n");
          newAiProviders = { ...newAiProviders, [aiProvider]: { ...(newAiProviders?.[aiProvider] ?? {}), apiKey: existingKey } };
          newDefaultAi = aiProvider;
        }
      } else {
        logger.info(`   ℹ️  Get a key at: ${hints[aiProvider]}\n`);
        const answer = await inquirer.prompt<{ apiKey: string }>([
          {
            type: "password",
            name: "apiKey",
            message: `${aiProvider} API key (leave blank to skip):`,
            mask: "*",
          },
        ]);
        if (!answer.apiKey.trim()) {
          logger.info("   Skipping — no key entered, AI provider not saved.\n");
        } else {
          newAiProviders = { ...newAiProviders, [aiProvider]: { ...(newAiProviders?.[aiProvider] ?? {}), apiKey: answer.apiKey } };
          newDefaultAi = aiProvider;
        }
      }
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  const merged: GitxConfig = {
    providers: updatedProviders,
    ...(Object.keys(newAiProviders).length ? { aiProviders: newAiProviders } : {}),
    ...(newDefaultAi ? { defaultAiProvider: newDefaultAi } : {}),
    ...(existing.defaultBranch ? { defaultBranch: existing.defaultBranch } : {}),
  };

  const spinner = ora("\nSaving config…").start();
  const savedPath = await saveConfig(merged);
  spinner.succeed(`Config saved to ${savedPath}`);

  const allProviders = Object.keys(merged.providers).join(", ");
  logger.success(`\n✅ gitx is ready!`);
  logger.info(`   Git providers: ${allProviders}`);
  logger.info(`   Default AI:    ${merged.defaultAiProvider ?? "not configured"}`);
  if (merged.aiProviders && Object.keys(merged.aiProviders).length > 1) {
    logger.info(`   All AI:        ${Object.keys(merged.aiProviders).join(", ")}`);
    logger.info(`   Switch AI:     gitx config set-default-ai`);
  }
  logger.info(`\nRun \`gitx pr list\` or \`gitx implement "<task>"\` in any git repo.`);
}
