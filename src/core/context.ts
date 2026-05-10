import type { ProviderKind } from "../types/provider.js";

export interface RepoContext {
  provider: ProviderKind;
  repoSlug: string; // provider-facing slug (GitHub/GitLab: owner/name)
  token: string;
  /**
   * How the token should be sent in the Authorization header.
   * - "pat"    → Basic base64(:{token})   (default, for GitHub/GitLab/Azure PAT)
   * - "bearer" → Bearer {token}           (for Azure GCM OAuth tokens)
   */
  tokenType?: "pat" | "bearer";
}

