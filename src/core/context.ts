import type { ProviderKind } from "../types/provider.js";

export interface RepoContext {
  provider: ProviderKind;
  repoSlug: string; // provider-facing slug (GitHub/GitLab: owner/name)
  token: string;
}

