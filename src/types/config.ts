import type { ProviderKind } from "./provider.js";

export interface GitxConfig {
  provider: ProviderKind;
  token: string;
  /**
   * Optional: when omitted, `gitx` will infer it from the current working directory's
   * `remote.origin.url` (where possible).
   *
   * Format: owner/name (or provider-specific slug).
   */
  repo?: string;
  defaultBranch: string;
}
