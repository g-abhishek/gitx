export interface GitxConfig {
  /**
   * Provider credentials. Configure one or more providers up-front using `gitx init`.
   * At runtime, gitx detects which provider to use based on the current repo's `remote.origin.url`.
   */
  providers: Partial<Record<"github" | "gitlab" | "azure", { token: string }>>;

  /**
   * Optional default branch to assume when it can't be inferred from the repo.
   * If omitted, gitx will attempt to infer it from git remotes.
   */
  defaultBranch?: string;
}
