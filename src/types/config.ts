export type AiProviderKind = "claude" | "openai" | "claude-cli";

export interface AiProviderEntry {
  /** Not needed for "claude-cli" */
  apiKey?: string;
  /** Optional model override */
  model?: string;
}

/**
 * Credential entry for a git hosting provider.
 *
 * - PAT (default): supply a `token` string.
 * - GCM (Azure only): set `authMethod: "gcm"` and omit `token`.
 *   gitx will call `git credential fill` via Git Credential Manager at
 *   runtime to obtain a short-lived OAuth Bearer token.
 */
export interface ProviderEntry {
  /** Personal Access Token. Required when authMethod is "pat" (default). */
  token?: string;
  /**
   * Authentication method.
   * - "pat"  (default) — PAT stored in the gitx config.
   * - "gcm"  — OAuth via Git Credential Manager (Azure DevOps only).
   */
  authMethod?: "pat" | "gcm";
}

export interface GitxConfig {
  /**
   * Git hosting provider credentials.
   * gitx auto-detects which one to use from the repo's remote.origin.url.
   */
  providers: Partial<Record<"github" | "gitlab" | "azure", ProviderEntry>>;

  /**
   * All configured AI providers.
   * - "claude"      → Anthropic API key required
   * - "openai"      → OpenAI API key required
   * - "claude-cli"→ uses locally installed `claude` CLI (no key needed)
   */
  aiProviders?: Partial<Record<AiProviderKind, AiProviderEntry>>;

  /**
   * Which AI provider to use by default.
   * If omitted, gitx checks env vars then auto-detects claude-cli.
   */
  defaultAiProvider?: AiProviderKind;

  /**
   * Default base branch when it can't be inferred from the remote.
   */
  defaultBranch?: string;

  /**
   * @deprecated Use aiProviders + defaultAiProvider.
   * Kept for backward-compat; migrated automatically on first load.
   */
  ai?: {
    provider: AiProviderKind;
    apiKey?: string;
    model?: string;
  };
}
