import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export function inferRepoSlugFromRemote(url: string): string | undefined {
  // Supports common GitHub/GitLab URL formats:
  // - git@github.com:owner/repo.git
  // - https://github.com/owner/repo(.git)
  // - ssh://git@github.com/owner/repo(.git)
  const cleaned = url.trim();

  const patterns: RegExp[] = [
    /^(?:git@)(?:github\.com|gitlab\.com):(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/i,
    /^(?:https?:\/\/)(?:github\.com|gitlab\.com)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?(?:\/)?$/i,
    /^(?:ssh:\/\/)(?:git@)(?:github\.com|gitlab\.com)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/i
  ];

  for (const re of patterns) {
    const match = re.exec(cleaned);
    const owner = match?.groups?.["owner"];
    const repo = match?.groups?.["repo"];
    if (owner && repo) return `${owner}/${repo}`;
  }

  return undefined;
}

export async function resolveRepoSlugFromCwd(cwd = process.cwd()): Promise<string | undefined> {
  const originUrl = await getGitRemoteOriginUrl(cwd);
  if (!originUrl) return undefined;
  return inferRepoSlugFromRemote(originUrl);
}
