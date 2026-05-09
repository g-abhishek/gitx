/**
 * Extended git operations for the implement workflow.
 * All functions execute native git commands via child_process.
 */

import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { GitxError } from "./errors.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ─── Internal helper ──────────────────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return String(stdout ?? "").trim();
  } catch (err: unknown) {
    const stderr =
      (err as { stderr?: string }).stderr ??
      (err as Error).message ??
      String(err);
    throw new GitxError(`git ${args[0]} failed: ${stderr.trim()}`, {
      exitCode: 1,
      cause: err,
    });
  }
}

// ─── Branch operations ────────────────────────────────────────────────────────

export async function getCurrentBranch(cwd = process.cwd()): Promise<string> {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/**
 * Resolve the default branch (main/master/develop) by inspecting the remote.
 * Falls back to "main" if nothing can be determined.
 */
export async function getDefaultBranchFromGit(
  cwd = process.cwd(),
  configuredDefault?: string
): Promise<string> {
  if (configuredDefault) return configuredDefault;

  try {
    // Try to read from remote HEAD reference
    const out = await git(
      ["rev-parse", "--abbrev-ref", "origin/HEAD"],
      cwd
    );
    // "origin/main" → "main"
    return out.replace(/^origin\//, "") || "main";
  } catch {
    // Fall back to checking common branch names
    try {
      const branches = await git(
        ["branch", "-r", "--format=%(refname:short)"],
        cwd
      );
      const candidates = ["origin/main", "origin/master", "origin/develop"];
      for (const candidate of candidates) {
        if (branches.split("\n").some((b) => b.trim() === candidate)) {
          return candidate.replace("origin/", "");
        }
      }
    } catch {
      /* ignore */
    }
    return "main";
  }
}

/**
 * Create and checkout a new branch.
 * If the branch already exists, just check it out.
 */
export async function createAndCheckoutBranch(
  branchName: string,
  cwd = process.cwd()
): Promise<void> {
  try {
    await git(["checkout", "-b", branchName], cwd);
  } catch {
    // Branch might already exist – try checking it out
    await git(["checkout", branchName], cwd);
  }
}

/** Sanitise a free-form task string into a valid branch name */
export function slugifyBranchName(task: string, prefix = "gitx"): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const ts = Date.now().toString(36);
  return `${prefix}/${slug}-${ts}`;
}

// ─── File operations ──────────────────────────────────────────────────────────

/**
 * Write content to a file inside the repo, creating parent directories as needed.
 * Paths should be relative to `cwd`.
 */
export async function writeRepoFile(
  relativePath: string,
  content: string,
  cwd = process.cwd()
): Promise<void> {
  const abs = resolve(join(cwd, relativePath));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}

// ─── Diff application ─────────────────────────────────────────────────────────

/**
 * Apply a unified diff string using `git apply`.
 * Returns `true` if applied cleanly, `false` if it failed (caller decides how
 * to handle partial failures).
 */
export async function applyUnifiedDiff(
  unifiedDiff: string,
  cwd = process.cwd()
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Use --3way to handle minor conflicts gracefully
    const { stdout, stderr } = await execAsync(
      `echo ${JSON.stringify(unifiedDiff)} | git apply --3way --whitespace=fix -`,
      { cwd }
    );
    return { ok: true, error: stderr || stdout || undefined };
  } catch (err: unknown) {
    const stderr =
      (err as { stderr?: string }).stderr ??
      (err as Error).message ??
      String(err);
    return { ok: false, error: stderr.trim() };
  }
}

// ─── Staging & committing ─────────────────────────────────────────────────────

export async function stageAll(cwd = process.cwd()): Promise<void> {
  await git(["add", "-A"], cwd);
}

export async function hasStagedChanges(cwd = process.cwd()): Promise<boolean> {
  try {
    const out = await git(["diff", "--cached", "--name-only"], cwd);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export async function commitChanges(
  message: string,
  cwd = process.cwd()
): Promise<string> {
  await git(["commit", "-m", message], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export async function pushBranch(
  branchName: string,
  cwd = process.cwd()
): Promise<void> {
  await git(["push", "--set-upstream", "origin", branchName], cwd);
}

// ─── Repo inspection ──────────────────────────────────────────────────────────

/**
 * List all tracked files in the repo (respects .gitignore).
 * Returns paths relative to `cwd`.
 */
export async function listTrackedFiles(cwd = process.cwd()): Promise<string[]> {
  try {
    const out = await git(["ls-files"], cwd);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get the unified diff of all uncommitted changes (staged + unstaged).
 */
export async function getWorkingDiff(cwd = process.cwd()): Promise<string> {
  try {
    const staged = await git(["diff", "--cached"], cwd);
    const unstaged = await git(["diff"], cwd);
    return [staged, unstaged].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

/**
 * Get a compact summary of staged changes (--stat format):
 * lists every changed file with insertion/deletion counts.
 * Always small regardless of diff size — used to give the AI the
 * complete picture of what changed even when the full diff is truncated.
 */
export async function getWorkingDiffStat(cwd = process.cwd()): Promise<string> {
  try {
    const staged = await git(["diff", "--cached", "--stat"], cwd);
    const unstaged = await git(["diff", "--stat"], cwd);
    return [staged, unstaged].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

/**
 * Auto-detect the most likely base branch for the current feature branch.
 *
 * Strategy:
 *   1. Check if the current branch has a configured upstream tracking branch.
 *   2. Otherwise, try common default branch names (main, master, develop, dev).
 *   3. For each candidate, count commits on HEAD that are NOT in that branch.
 *      The candidate with the fewest such commits is the likely origin.
 *
 * Falls back to "main" if nothing can be determined.
 */
export async function detectBaseBranch(cwd = process.cwd()): Promise<string> {
  // Get current branch name upfront — used for all checks below
  const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => "");

  // 1. Try upstream tracking branch — only useful if it points to a DIFFERENT
  //    branch (e.g. origin/main), not the branch's own remote tracking ref.
  //    e.g. "origin/gitx/test" → "gitx/test" == current → skip
  //         "origin/main"      → "main"       != current → use it
  try {
    const upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
    const branch = upstream.replace(/^[^/]+\//, "").trim();
    if (branch && branch !== current) return branch;
  } catch {
    // No upstream configured — fall through
  }

  // 2. Check remote HEAD (origin's default branch)
  try {
    const remoteHead = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd);
    const branch = remoteHead.replace(/^origin\//, "").trim();
    if (branch && branch !== current) return branch;
  } catch {
    // Not available — fall through
  }

  // 3. Count commits ahead of each common default branch name
  const candidates = ["main", "master", "develop", "dev", "staging"];
  const counts: Array<{ branch: string; ahead: number }> = [];
  for (const candidate of candidates) {
    if (candidate === current) continue;
    try {
      // Count commits on HEAD not in candidate
      const out = await git(["rev-list", "--count", `${candidate}..HEAD`], cwd);
      counts.push({ branch: candidate, ahead: parseInt(out.trim(), 10) || 0 });
    } catch {
      // Branch doesn't exist locally — skip
    }
  }

  if (counts.length > 0) {
    // Pick the branch with the fewest commits ahead (closest ancestor)
    counts.sort((a, b) => a.ahead - b.ahead);
    return counts[0]!.branch;
  }

  return "main";
}

/**
 * Get the one-line commit log for commits on HEAD that are not in baseBranch.
 * Used to give AI context about what this branch adds.
 */
export async function getBranchCommits(
  cwd = process.cwd(),
  baseBranch = "main"
): Promise<string[]> {
  try {
    const out = await git(
      ["log", "--oneline", "--no-decorate", `${baseBranch}..HEAD`],
      cwd
    );
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get the unified diff of all changes between baseBranch and HEAD.
 * This is what the PR reviewer would see — all additions across all commits.
 */
export async function getBranchDiff(
  cwd = process.cwd(),
  baseBranch = "main"
): Promise<string> {
  try {
    // Three-dot diff: all changes introduced by this branch vs. the merge base
    return await git(["diff", `${baseBranch}...HEAD`], cwd);
  } catch {
    return "";
  }
}

/**
 * Read file content as a string. Returns empty string if file doesn't exist.
 */
export async function readRepoFile(
  relativePath: string,
  cwd = process.cwd()
): Promise<string | undefined> {
  try {
    const abs = resolve(join(cwd, relativePath));
    const { readFile } = await import("node:fs/promises");
    return await readFile(abs, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Check whether a branch exists on the remote (origin).
 * Uses git ls-remote which does not require a full fetch.
 */
export async function branchExistsOnRemote(
  branchName: string,
  cwd = process.cwd()
): Promise<boolean> {
  try {
    const out = await git(
      ["ls-remote", "--heads", "origin", `refs/heads/${branchName}`],
      cwd
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Returns true if the working tree has uncommitted changes (staged or unstaged).
 */
export async function isWorkingTreeDirty(cwd = process.cwd()): Promise<boolean> {
  try {
    const out = await git(["status", "--porcelain"], cwd);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
