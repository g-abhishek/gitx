import type { GitxConfig } from "../types/config.js";
import { loadConfig } from "../config/config.js";
import { MockAi } from "../ai/mockAi.js";
import type { AiClient } from "../ai/types.js";
import type { GitxPlugin } from "./plugin.js";

export class Gitx {
  public readonly config: GitxConfig;
  public readonly ai: AiClient;
  private readonly plugins: GitxPlugin[] = [];

  private constructor(args: { config: GitxConfig; ai: AiClient }) {
    this.config = args.config;
    this.ai = args.ai;
  }

  static async fromCwd(cwd = process.cwd()): Promise<Gitx> {
    const config = await loadConfig(cwd);
    const ai = new MockAi();
    return new Gitx({ config, ai });
  }

  async use(plugin: GitxPlugin): Promise<void> {
    this.plugins.push(plugin);
    await plugin.setup(this);
  }
}

