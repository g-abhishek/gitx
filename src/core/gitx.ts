import type { GitxConfig } from "../types/config.js";
import { loadConfig } from "../config/config.js";
import { MockAi } from "../ai/mockAi.js";
import { ClaudeAi } from "../ai/claudeAi.js";
import type { AiClient } from "../ai/types.js";
import type { GitxPlugin } from "./plugin.js";
import {
  detectProviderFromRemote,
  getGitRemoteOriginUrl,
  inferRepoSlugFromRemote,
  isInsideGitRepo,
} from "../utils/git.js";
import { GitxError } from "../utils/errors.js";
import type { RepoContext } from "./context.js";

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

  /**
   * Create a Gitx instance from the current working directory.
   *
   * AI backend selection:
   *   - If ANTHROPIC_API_KEY is set → ClaudeAi (real, requires network)
   *   - Otherwise → MockAi (returns placeholder data, no network calls)
   *
   * Override via GITX_AI_MODEL to use a different Claude model.
   */
  static async fromCwd(cwd = process.cwd()): Promise<Gitx> {
    const config = await loadConfig(cwd);
    const ai: AiClient = ClaudeAi.isAvailable() ? new ClaudeAi() : new MockAi();
    return new Gitx({ config, ai, cwd });
  }

  /** Register a plugin and call its setup hook. */
  async use(plugin: GitxPlugin): Promise<void> {
    this.plugins.push(plugin);
    await plugin.setup(this);
  }

  /**
   * Detect the repo provider, slug, and access token from the current
   * working directory's git remote and the loaded config.
   */
  async getRepoContext(): Promise<RepoContext> {
    if (!(await isInsideGitRepo(this.cwd))) {
      throw new GitxError(
        "No git repo detected in the current directory. Run gitx inside a git repository.",
        { exitCode: 2 }
      );
    }

    const originUrl = await getGitRemoteOriginUrl(this.cwd);
    if (!originUrl) {
      throw new GitxError(
        "No `remote.origin.url` detected. Add an origin remote and retry.",
        { exitCode: 2 }
      );
    }

    const provider = detectProviderFromRemote(originUrl);
    if (!provider) {
      throw new GitxError(
        `Unsupported git remote host for auto-detection: ${originUrl}.\n` +
          "Supported hosts: github.com, gitlab.com, dev.azure.com.",
        { exitCode: 2 }
      );
    }

    const token = this.config.providers[provider]?.token;
    if (!token) {
      throw new GitxError(
        `No token configured for provider "${provider}". ` +
          `Re-run \`gitx init\` or \`gitx config set-provider ${provider}\` to add credentials.`,
        { exitCode: 2 }
      );
    }

    const repoSlug = inferRepoSlugFromRemote(originUrl);
    if (!repoSlug) {
      throw new GitxError(
        `Could not infer repo slug from origin remote: ${originUrl}.`,
        { exitCode: 2 }
      );
    }

    return { provider, repoSlug, token };
  }

  async getRepoSlug(): Promise<string> {
    const ctx = await this.getRepoContext();
    return ctx.repoSlug;
  }

  async getProvider(): Promise<RepoContext["provider"]> {
    const ctx = await this.getRepoContext();
    return ctx.provider;
  }

  async getToken(): Promise<string> {
    const ctx = await this.getRepoContext();
    return ctx.token;
  }
}
