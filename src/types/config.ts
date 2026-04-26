import type { ProviderKind } from "./provider.js";

export interface GitxConfig {
  provider: ProviderKind;
  token: string;
  repo: string; // owner/name (or provider-specific slug)
  defaultBranch: string;
}

