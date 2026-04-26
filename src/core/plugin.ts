import type { Gitx } from "./gitx.js";

export interface GitxPlugin {
  name: string;
  setup(gitx: Gitx): void | Promise<void>;
}

