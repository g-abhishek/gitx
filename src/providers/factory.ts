import type { RepoContext } from "../core/context.js";
import type { GitProvider } from "./base.js";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";
import { AzureProvider } from "./azure.js";
import { GitxError } from "../utils/errors.js";

/**
 * Instantiate the correct {@link GitProvider} for the given repo context.
 * The provider reads the token from `ctx.token` and the slug from `ctx.repoSlug`.
 */
export function createProvider(ctx: RepoContext): GitProvider {
  switch (ctx.provider) {
    case "github":
      return new GitHubProvider(ctx.token);
    case "gitlab":
      return new GitLabProvider(ctx.token);
    case "azure":
      // Azure needs org/project/repo parsed from the slug.
      // tokenType distinguishes PAT (Basic auth) from GCM OAuth (Bearer auth).
      return new AzureProvider(ctx.token, ctx.repoSlug, ctx.tokenType ?? "pat");
    default: {
      const p: never = ctx.provider;
      throw new GitxError(`Unsupported provider: ${String(p)}`, { exitCode: 2 });
    }
  }
}
