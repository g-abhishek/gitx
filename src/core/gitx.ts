import type { GitxConfig } from "../types/config.js";
import { loadConfig } from "../config/config.js";
import { MockAi } from "../ai/mockAi.js";
import type { AiClient } from "../ai/types.js";
import type { GitxPlugin } from "./plugin.js";
import { resolveRepoSlugFromCwd } from "../utils/git.js";
import { GitxError } from "../utils/errors.js";

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

  static async fromCwd(cwd = process.cwd()): Promise<Gitx> {
    const config = await loadConfig(cwd);
    const ai = new MockAi();
    return new Gitx({ config, ai, cwd });
  }

  async use(plugin: GitxPlugin): Promise<void> {
    this.plugins.push(plugin);
    await plugin.setup(this);
  }

  async getRepoSlug(): Promise<string> {
    if (this.config.repo && this.config.repo.trim().length > 0) return this.config.repo;
    const inferred = await resolveRepoSlugFromCwd(this.cwd);
    if (inferred) return inferred;
    throw new GitxError(
      "Repo not configured and could not be inferred from git remote. Set `repo` in gitx config or run `gitx init` inside a repo with `origin`.",
      { exitCode: 2 },
    );
  }
}
