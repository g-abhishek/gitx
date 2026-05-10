import type { GitxConfig, AiProviderKind } from "../types/config.js";
import { loadConfig } from "../config/config.js";
import { MockAi } from "../ai/mockAi.js";
import { ClaudeAi } from "../ai/claudeAi.js";
import { ClaudeCliAi } from "../ai/claudeCliAi.js";
import { OpenAiAi } from "../ai/openAiAi.js";
import type { AiClient } from "../ai/types.js";
import type { GitxPlugin } from "./plugin.js";
import {
  detectProviderFromRemote,
  getGitRemoteOriginUrl,
  inferRepoSlugFromRemote,
  isInsideGitRepo,
} from "../utils/git.js";
import { GitxError } from "../utils/errors.js";
import { logger } from "../logger/logger.js";
import type { RepoContext } from "./context.js";
import { getTokenViaGcm } from "../utils/azureAuth.js";

export class Gitx {
  public readonly config: GitxConfig;
  public readonly ai: AiClient;
  public readonly cwd: string;
  private readonly plugins: GitxPlugin[] = [];

  private constructor(args: { config: GitxConfig; ai: AiClient; cwd: string }) {
    this.config = args.config;
    this.ai = args.ai;
    this.cwd = args.cwd;
  }

  // ─── AI resolution ─────────────────────────────────────────────────────────

  /**
   * Resolve the active Anthropic API key.
   * Priority: ANTHROPIC_API_KEY env var → aiProviders.claude.apiKey → legacy ai.apiKey
   */
  static resolveAiKey(config: GitxConfig): string | undefined {
    return (
      process.env["ANTHROPIC_API_KEY"] ??
      config.aiProviders?.claude?.apiKey ??
      config.ai?.apiKey
    );
  }

  /**
   * Resolve the OpenAI API key.
   * Priority: OPENAI_API_KEY env var → aiProviders.openai.apiKey
   */
  static resolveOpenAiKey(config: GitxConfig): string | undefined {
    return process.env["OPENAI_API_KEY"] ?? config.aiProviders?.openai?.apiKey;
  }

  /**
   * Check whether any real AI (API key or local CLI) is available.
   */
  static isAiAvailable(config: GitxConfig): boolean {
    if (Gitx.resolveAiKey(config)) return true;
    if (Gitx.resolveOpenAiKey(config)) return true;
    if (config.aiProviders?.["claude-cli"] !== undefined) return true;
    if (config.defaultAiProvider) return true;
    return false;
  }

  /**
   * Build the best available AiClient for the given config.
   *
   * Selection cascade:
   *  1. ANTHROPIC_API_KEY env var         → ClaudeAi (remote API)
   *  2. defaultAiProvider in config       → use that specific provider
   *  3. Any configured aiProviders entry  → first one found with a key
   *  4. Auto-detect local `claude` CLI    → ClaudeCliAi (free, no key)
   *  5. MockAi fallback                   → placeholders, warns user
   */
  static async buildAi(config: GitxConfig): Promise<AiClient> {
    // 1. Env vars always win (Anthropic takes precedence over OpenAI)
    const envClaudeKey = process.env["ANTHROPIC_API_KEY"];
    if (envClaudeKey) {
      return new ClaudeAi(envClaudeKey, config.aiProviders?.claude?.model);
    }
    const envOpenAiKey = process.env["OPENAI_API_KEY"];
    if (envOpenAiKey) {
      return new OpenAiAi(envOpenAiKey, config.aiProviders?.openai?.model);
    }

    // 2. Use the configured default provider
    const defaultProv = config.defaultAiProvider;
    if (defaultProv) {
      const result = await Gitx._buildForProvider(defaultProv, config);
      if (result) return result;
      // If it failed (e.g. claude-cli not installed), fall through with a warning
      logger.warn(`⚠️  Default AI provider "${defaultProv}" is not available. Falling back…`);
    }

    // 3. Scan all configured aiProviders for one that works
    const allEntries = Object.entries(config.aiProviders ?? {}) as Array<
      [AiProviderKind, { apiKey?: string; model?: string }]
    >;
    for (const [kind, entry] of allEntries) {
      if (kind === defaultProv) continue; // already tried above
      const result = await Gitx._buildForProvider(kind, config, entry);
      if (result) return result;
    }

    // 4. Auto-detect locally installed claude CLI (no key needed)
    if (await ClaudeCliAi.isAvailable()) {
      logger.info("🔍 Auto-detected local Claude CLI — using it for AI features.");
      return new ClaudeCliAi();
    }

    // 5. MockAi fallback
    return new MockAi();
  }

  /** Build an AiClient for a specific provider kind. Returns null if not possible. */
  private static async _buildForProvider(
    kind: AiProviderKind,
    config: GitxConfig,
    entry?: { apiKey?: string; model?: string }
  ): Promise<AiClient | null> {
    const provEntry = entry ?? config.aiProviders?.[kind];

    switch (kind) {
      case "claude": {
        const key = provEntry?.apiKey;
        if (key) return new ClaudeAi(key, provEntry?.model);
        return null;
      }
      case "openai": {
        const key = process.env["OPENAI_API_KEY"] ?? provEntry?.apiKey;
        if (key) return new OpenAiAi(key, provEntry?.model);
        return null;
      }
      case "claude-cli": {
        if (await ClaudeCliAi.isAvailable()) return new ClaudeCliAi();
        return null;
      }
      default:
        return null;
    }
  }

  // ─── Factory ────────────────────────────────────────────────────────────────

  /**
   * Create a Gitx instance from the current working directory.
   * Never throws due to missing config — returns graceful defaults.
   */
  static async fromCwd(cwd = process.cwd()): Promise<Gitx> {
    let config: GitxConfig;
    try {
      config = await loadConfig(cwd);
    } catch {
      config = { providers: {} };
    }

    const ai = await Gitx.buildAi(config);
    return new Gitx({ config, ai, cwd });
  }

  // ─── Plugin system ──────────────────────────────────────────────────────────

  async use(plugin: GitxPlugin): Promise<void> {
    this.plugins.push(plugin);
    await plugin.setup(this);
  }

  // ─── Repo context ───────────────────────────────────────────────────────────

  /**
   * Resolve provider, repoSlug, and token for the current repo.
   * Shows actionable guidance instead of crashing when token is missing.
   */
  async getRepoContext(): Promise<RepoContext> {
    if (!(await isInsideGitRepo(this.cwd))) {
      throw new GitxError(
        "Not inside a git repository. Navigate to a git repo and retry.",
        { exitCode: 2 }
      );
    }

    const originUrl = await getGitRemoteOriginUrl(this.cwd);
    if (!originUrl) {
      throw new GitxError(
        "No remote.origin.url found. Add an origin remote:\n" +
        "  git remote add origin <url>",
        { exitCode: 2 }
      );
    }

    const provider = detectProviderFromRemote(originUrl);
    if (!provider) {
      throw new GitxError(
        `Could not detect a supported provider from: ${originUrl}\n` +
        "  Supported: github.com, gitlab.com, dev.azure.com",
        { exitCode: 2 }
      );
    }

    const repoSlug = inferRepoSlugFromRemote(originUrl);
    if (!repoSlug) {
      throw new GitxError(
        `Could not parse repo slug from remote: ${originUrl}`,
        { exitCode: 2 }
      );
    }

    const providerConfig = this.config.providers[provider];
    const authMethod = providerConfig?.authMethod ?? "pat";

    // ── GCM path (Azure DevOps only) ─────────────────────────────────────────
    if (authMethod === "gcm") {
      if (provider !== "azure") {
        throw new GitxError(
          `GCM authentication is only supported for Azure DevOps, not "${provider}".`,
          { exitCode: 2 }
        );
      }
      // Org is the first segment of the Azure slug: "org/project/repo"
      const org = repoSlug.split("/")[0];
      if (!org) {
        throw new GitxError(
          `Cannot determine Azure DevOps org from repo slug: ${repoSlug}`,
          { exitCode: 2 }
        );
      }
      let token: string;
      try {
        token = await getTokenViaGcm(org);
      } catch (err: unknown) {
        throw new GitxError(
          `GCM authentication failed: ${err instanceof Error ? err.message : String(err)}`,
          { exitCode: 1 }
        );
      }
      return { provider, repoSlug, token, tokenType: "bearer" };
    }

    // ── PAT path (default) ───────────────────────────────────────────────────
    const token = providerConfig?.token;
    if (!token) {
      throw new GitxError(
        `This repo uses ${provider} but no ${provider} token is configured.\n` +
        `  Run:  gitx config\n` +
        `  Or:   gitx config set ${provider}`,
        { exitCode: 2 }
      );
    }

    return { provider, repoSlug, token, tokenType: "pat" };
  }

  async getRepoSlug(): Promise<string> {
    return (await this.getRepoContext()).repoSlug;
  }

  async getProvider(): Promise<RepoContext["provider"]> {
    return (await this.getRepoContext()).provider;
  }

  async getToken(): Promise<string> {
    return (await this.getRepoContext()).token;
  }

  /**
   * Detect provider from the current repo without requiring a configured token.
   * Useful for showing the user what they need to configure.
   */
  async detectProvider(): Promise<{ provider: string; repoSlug: string } | undefined> {
    try {
      const originUrl = await getGitRemoteOriginUrl(this.cwd);
      if (!originUrl) return undefined;
      const provider = detectProviderFromRemote(originUrl);
      const repoSlug = inferRepoSlugFromRemote(originUrl);
      if (!provider || !repoSlug) return undefined;
      return { provider, repoSlug };
    } catch {
      return undefined;
    }
  }
}
