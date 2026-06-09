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
import { verifyGcmSetup } from "../../utils/azureAuth.js";

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
    if (v?.authMethod === "gcm") {
      providers[k] = { authMethod: "gcm" };
    } else {
      providers[k] = v?.token ? { token: v.token.slice(0, 6) + "***", authMethod: v.authMethod ?? "pat" } : {};
    }
  }
  const aiProviders: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config.aiProviders ?? {})) {
    aiProviders[k] = k === "claude-cli"
      ? { type: "local CLI" }
      : { apiKey: v?.apiKey ? v.apiKey.slice(0, 6) + "***" : "(none)", ...(v?.model ? { model: v.model } : {}) };
  }
  const jira = config.jira
    ? {
        url: config.jira.url,
        email: config.jira.email,
        apiToken: config.jira.apiToken.slice(0, 6) + "***",
        ...(config.jira.projectKey ? { projectKey: config.jira.projectKey } : {}),
      }
    : undefined;

  return {
    ...config,
    providers,
    ...(Object.keys(aiProviders).length ? { aiProviders } : {}),
    ...(jira ? { jira } : {}),
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
        const provCfg = cfg.providers[detected.provider as ProviderKind];
        const authMethod = provCfg?.authMethod ?? "pat";
        if (authMethod === "gcm") {
          logger.success(`   ${detected.provider}: configured via GCM (OAuth) ✓`);
        } else if (provCfg?.token) {
          logger.success(`   ${detected.provider} token: configured (PAT) ✓`);
        } else {
          logger.warn(`   ${detected.provider} token: NOT configured — run: gitx config set ${detected.provider}`);
        }
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

      // Show Jira status
      if (cfg.jira) {
        logger.success(`\n🎫 Jira: ${cfg.jira.url}  (${cfg.jira.email})${cfg.jira.projectKey ? `  Project: ${cfg.jira.projectKey}` : ""}`);
      } else {
        logger.info("\n🎫 Jira: not configured — run: gitx config set jira");
      }

      logger.info(`\n📍 Config file: ${getConfigPath()}`);
      logger.info(JSON.stringify(redactConfig(cfg), null, 2));
    });

  // ── gitx config set <KEY> [value] ─────────────────────────────────────────
  // KEY = github | gitlab | azure | claude | openai | claude-cli | jira
  config
    .command("set")
    .description(
      "🔑 Set a provider token or AI key (also sets it as the default AI)\n" +
      "  Git:  gitx config set github|gitlab|azure [token]\n" +
      "  AI:   gitx config set claude|openai [apiKey]\n" +
      "        gitx config set claude-cli\n" +
      "  Jira: gitx config set jira"
    )
    .argument("<key>", "Provider: github | gitlab | azure | claude | openai | claude-cli | jira")
    .argument("[value]", "Token or API key (prompted if omitted; not needed for claude-cli or jira)")
    .action(async (key: string, valueArg?: string) => {
      if (isGitProvider(key)) {
        await setGitProvider(key, valueArg);
      } else if (isAiProvider(key)) {
        await setAiProvider(key, valueArg);
      } else if (key === "jira") {
        await setJiraConfig();
      } else {
        throw new GitxError(
          `Unknown key: "${key}". Use one of: github, gitlab, azure, claude, openai, claude-cli, jira`,
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

  // Azure DevOps: offer GCM (OAuth) or PAT
  if (provider === "azure") {
    await setAzureProvider(existing, tokenArg);
    return;
  }

  const hints: Record<Exclude<GitProviderKey, "azure">, string> = {
    github: "github.com/settings/tokens → New token → scope: repo",
    gitlab: "gitlab.com/-/profile/personal_access_tokens → scope: api",
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

// ─── Azure DevOps: GCM or PAT ─────────────────────────────────────────────────

async function setAzureProvider(existing: GitxConfig, tokenArg?: string): Promise<void> {
  const currentMethod = existing.providers.azure?.authMethod ?? "pat";

  logger.info("\n🔐 Azure DevOps authentication\n");
  logger.info("   Your company may restrict PAT tokens. GCM (OAuth) is the recommended method.\n");

  const { authMethod } = await inquirer.prompt<{ authMethod: "gcm" | "pat" }>([
    {
      type: "list",
      name: "authMethod",
      message: "Authentication method:",
      choices: [
        {
          name: `GCM — Git Credential Manager (OAuth, no token to manage)${currentMethod === "gcm" ? "  ✓ current" : " ← recommended"}`,
          value: "gcm",
        },
        {
          name: `PAT — Personal Access Token${currentMethod === "pat" ? "  ✓ current" : ""}`,
          value: "pat",
        },
      ],
      default: currentMethod,
    },
  ]);

  if (authMethod === "gcm") {
    await setupAzureGcm(existing);
  } else {
    await setupAzurePat(existing, tokenArg);
  }
}

async function setupAzureGcm(existing: GitxConfig): Promise<void> {
  logger.info("\n── GCM setup\n");
  logger.info("   GCM uses `git credential fill` to obtain a short-lived OAuth token.");
  logger.info("   No token is stored in the gitx config — GCM is the secure credential store.\n");

  // Try to detect the org from the current repo remote
  let detectedOrg: string | undefined;
  try {
    const gitx = await Gitx.fromCwd();
    const det = await gitx.detectProvider();
    if (det?.provider === "azure") {
      detectedOrg = det.repoSlug.split("/")[0];
    }
  } catch { /* not in a git repo */ }

  const { org } = await inquirer.prompt<{ org: string }>([
    {
      type: "input",
      name: "org",
      message: "Azure DevOps org name (e.g. MyCompany):",
      default: detectedOrg,
      validate: validateNonEmpty("Org name"),
    },
  ]);

  const verifySpinner = ora("Verifying GCM setup…").start();
  const result = await verifyGcmSetup(org);

  if (result.ok) {
    verifySpinner.succeed("GCM is correctly configured and a token was fetched successfully ✓");
  } else {
    verifySpinner.warn("GCM setup has issues:");
    result.issues.forEach((issue) => logger.warn(`   ✗ ${issue}`));
    if (result.fixes.length > 0) {
      logger.info("\n   Run these commands to fix the issues:");
      result.fixes.forEach((fix) => logger.info(`     $ ${fix}`));
    }
    logger.info("");

    const { saveAnyway } = await inquirer.prompt<{ saveAnyway: boolean }>([
      {
        type: "confirm",
        name: "saveAnyway",
        message: "Save GCM config anyway? (you can fix the issues and it will work next time)",
        default: false,
      },
    ]);
    if (!saveAnyway) {
      logger.info("   Cancelled — no changes saved.");
      return;
    }
  }

  const updated: GitxConfig = {
    ...existing,
    providers: {
      ...existing.providers,
      azure: { authMethod: "gcm" },
    },
  };

  const spinner = ora("Saving…").start();
  const path = await saveConfig(updated);
  spinner.succeed(`Saved to ${path}`);
  logger.success("✅ Azure DevOps configured to use GCM (OAuth).");
  logger.info("   gitx will call `git credential fill` automatically when needed.");
}

async function setupAzurePat(existing: GitxConfig, tokenArg?: string): Promise<void> {
  logger.info("\n── PAT setup\n");
  logger.info("   ℹ️  Get a PAT at: dev.azure.com → User settings → Personal access tokens\n");
  logger.info("          Scope required: Code (Read & write)\n");

  const token = tokenArg?.trim().length
    ? tokenArg.trim()
    : (await inquirer.prompt<{ token: string }>([
        {
          type: "password",
          name: "token",
          message: "Azure DevOps PAT token:",
          mask: "*",
          validate: validateNonEmpty("Token"),
        },
      ])).token;

  const updated: GitxConfig = {
    ...existing,
    providers: {
      ...existing.providers,
      azure: { token, authMethod: "pat" },
    },
  };

  const spinner = ora("Saving…").start();
  const path = await saveConfig(updated);
  spinner.succeed(`Saved to ${path}`);
  logger.success("✅ Azure DevOps PAT token saved.");
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
  logger.info("   Your configured provider takes priority over any AI-related environment variables.");
}

// ─── Set Jira config ──────────────────────────────────────────────────────────

async function setJiraConfig(): Promise<void> {
  const existing = await loadOrEmpty();
  const current = existing.jira;

  logger.info("\n🎫 Jira integration setup\n");
  logger.info("   This lets you run:  gitx implement --jira PROJ-123");
  logger.info("   gitx will read the ticket, implement it, and link the PR back.\n");

  const { url } = await inquirer.prompt<{ url: string }>([
    {
      type: "input",
      name: "url",
      message: "Jira base URL (e.g. https://yourorg.atlassian.net):",
      default: current?.url,
      validate: (v: string) => v.trim().startsWith("http") ? true : "Must be a valid URL starting with http(s)://",
    },
  ]);

  const { email } = await inquirer.prompt<{ email: string }>([
    {
      type: "input",
      name: "email",
      message: "Atlassian account email:",
      default: current?.email,
      validate: validateNonEmpty("Email"),
    },
  ]);

  logger.info("\n   ℹ️  Create an API token at: https://id.atlassian.com/manage-profile/security/api-tokens\n");

  const { apiToken } = await inquirer.prompt<{ apiToken: string }>([
    {
      type: "password",
      name: "apiToken",
      message: "Atlassian API token:",
      mask: "*",
      validate: validateNonEmpty("API token"),
    },
  ]);

  const { projectKey } = await inquirer.prompt<{ projectKey: string }>([
    {
      type: "input",
      name: "projectKey",
      message: "Default project key (optional, e.g. PROJ — lets you use --jira 123 instead of PROJ-123):",
      default: current?.projectKey ?? "",
    },
  ]);

  const updated: GitxConfig = {
    ...existing,
    jira: {
      url: url.trim().replace(/\/$/, ""),
      email: email.trim(),
      apiToken: apiToken.trim(),
      ...(projectKey.trim() ? { projectKey: projectKey.trim().toUpperCase() } : {}),
    },
  };

  const spinner = ora("Saving…").start();
  const path = await saveConfig(updated);
  spinner.succeed(`Saved to ${path}`);
  logger.success("✅ Jira configured!");
  logger.info(`   Use it: gitx implement --jira ${updated.jira?.projectKey ? `${updated.jira.projectKey}-123` : "PROJ-123"}`);
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
  logger.info("── Step 1 of 3: Git provider\n");

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
  } else if (providerOrSkip === "azure") {
    // Azure DevOps — delegate to the full GCM/PAT wizard which saves its own config
    await setAzureProvider(existing);
    // Reload providers so the merged save below reflects any changes
    const reloaded = await loadOrEmpty();
    updatedProviders = reloaded.providers;
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
  logger.info("\n── Step 2 of 3: AI provider\n");

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

  // ── Step 3: Jira integration (optional) ──────────────────────────────────
  logger.info("\n── Step 3 of 3: Jira integration (optional)\n");
  logger.info("   Enables: gitx implement --jira PROJ-123");
  logger.info("   gitx will read the ticket, implement it, and link the PR back.\n");

  const { setupJira } = await inquirer.prompt<{ setupJira: boolean }>([
    {
      type: "confirm",
      name: "setupJira",
      message: existing.jira
        ? `Jira already configured (${existing.jira.url}). Reconfigure?`
        : "Set up Jira integration?",
      default: false,
    },
  ]);

  let newJira = existing.jira;
  if (setupJira) {
    await setJiraConfig();
    // Reload to pick up what setJiraConfig saved
    const reloaded = await loadOrEmpty();
    newJira = reloaded.jira;
  } else if (existing.jira) {
    logger.info("   Keeping existing Jira config.\n");
  } else {
    logger.info("   Skipped — run `gitx config set jira` anytime to set it up.\n");
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  const merged: GitxConfig = {
    providers: updatedProviders,
    ...(Object.keys(newAiProviders).length ? { aiProviders: newAiProviders } : {}),
    ...(newDefaultAi ? { defaultAiProvider: newDefaultAi } : {}),
    ...(existing.defaultBranch ? { defaultBranch: existing.defaultBranch } : {}),
    ...(newJira ? { jira: newJira } : {}),
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
  logger.info(`   Jira:          ${merged.jira ? `${merged.jira.url} (${merged.jira.email})` : "not configured"}`);
  logger.info(`\nRun \`gitx pr list\` or \`gitx implement "<task>"\` in any git repo.`);
}
