import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderKind } from "../types/provider.js";

const execFileAsync = promisify(execFile);

export async function getGitRemoteOriginUrl(cwd = process.cwd()): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd });
    const url = String(stdout ?? "").trim();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function isInsideGitRepo(cwd = process.cwd()): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return String(stdout ?? "").trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Infer a "owner/repo" slug from a git remote URL.
 *
 * Handles:
 *   GitHub / GitLab:
 *     git@github.com:owner/repo.git
 *     https://github.com/owner/repo(.git)
 *     ssh://git@github.com/owner/repo(.git)
 *
 *   Azure DevOps:
 *     https://dev.azure.com/org/project/_git/repo
 *     https://org.visualstudio.com/project/_git/repo
 *     org@vs-ssh.visualstudio.com:v3/org/project/repo
 *
 * Returns:
 *   GitHub/GitLab: "owner/repo"
 *   Azure:         "org/project/repo"
 */
export function inferRepoSlugFromRemote(url: string): string | undefined {
  const cleaned = url.trim();

  // ── GitHub / GitLab ──────────────────────────────────────────────────────
  const ghGlPatterns: RegExp[] = [
    /^(?:git@)(?:github\.com|gitlab\.com):(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/i,
    /^(?:https?:\/\/)(?:github\.com|gitlab\.com)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?(?:\/)?$/i,
    /^(?:ssh:\/\/)(?:git@)?(?:github\.com|gitlab\.com)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/i,
  ];

  for (const re of ghGlPatterns) {
    const match = re.exec(cleaned);
    const owner = match?.groups?.["owner"];
    const repo = match?.groups?.["repo"];
    if (owner && repo) return `${owner}/${repo}`;
  }

  // ── Azure DevOps HTTPS ────────────────────────────────────────────────────
  // https://dev.azure.com/{org}/{project}/_git/{repo}
  const azHttps = /https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?(?:\/)?$/i.exec(cleaned);
  if (azHttps) return `${azHttps[1]}/${azHttps[2]}/${azHttps[3]}`;

  // https://{org}.visualstudio.com/{project}/_git/{repo}
  const azVs = /https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?(?:\/)?$/i.exec(cleaned);
  if (azVs) return `${azVs[1]}/${azVs[2]}/${azVs[3]}`;

  // ── Azure DevOps SSH ──────────────────────────────────────────────────────
  // {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
  const azSsh = /^[^@]+@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(cleaned);
  if (azSsh) return `${azSsh[1]}/${azSsh[2]}/${azSsh[3]}`;

  return undefined;
}

export async function resolveRepoSlugFromCwd(cwd = process.cwd()): Promise<string | undefined> {
  const originUrl = await getGitRemoteOriginUrl(cwd);
  if (!originUrl) return undefined;
  return inferRepoSlugFromRemote(originUrl);
}

export function detectProviderFromRemote(url: string): ProviderKind | undefined {
  const cleaned = url.trim();
  if (cleaned.includes("github.com")) return "github";
  if (cleaned.includes("gitlab.com")) return "gitlab";
  if (
    cleaned.includes("dev.azure.com") ||
    cleaned.includes("visualstudio.com") ||
    cleaned.includes("vs-ssh.visualstudio.com")
  ) {
    return "azure";
  }
  return undefined;
}
