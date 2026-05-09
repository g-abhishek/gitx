/**
 * Helpers for handling .git/index.lock conflicts safely.
 *
 * A lock file can mean two things:
 *   A) A previous git process crashed and left a stale lock  → safe to remove
 *   B) Another git process is actively running right now     → UNSAFE to remove
 *
 * We distinguish them by checking the lock file's modification time:
 *   - Older than STALE_THRESHOLD_MS → almost certainly stale, remove and retry
 *   - Newer than threshold          → likely active; warn the user and abort
 */

import { unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger/logger.js";
import { GitxError } from "./errors.js";

const STALE_THRESHOLD_MS = 30_000; // 30 seconds

export async function withLockRetry<T>(fn: () => Promise<T>, cwd: string): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("index.lock")) throw err;

    const lockPath = join(cwd, ".git", "index.lock");

    // Check how old the lock file is
    let ageMs = Infinity;
    try {
      const info = await stat(lockPath);
      ageMs = Date.now() - info.mtimeMs;
    } catch {
      // Lock file already gone — just retry
      return await fn();
    }

    if (ageMs < STALE_THRESHOLD_MS) {
      // Lock is fresh — another git process is likely running right now
      throw new GitxError(
        "A git process appears to be running in this repo (index.lock is recent).\n" +
        "  Wait for it to finish, then retry.\n" +
        "  If you're sure nothing is running:\n" +
        `    rm "${lockPath}"`,
        { exitCode: 1 }
      );
    }

    // Lock is old — safe to treat as stale and remove
    logger.warn(`⚠️  Found stale .git/index.lock (${Math.round(ageMs / 1000)}s old) — removing and retrying…`);
    try {
      await unlink(lockPath);
    } catch {
      throw new GitxError(
        `Could not remove stale lock file: "${lockPath}"\n  Try: rm "${lockPath}"`,
        { exitCode: 1 }
      );
    }

    return await fn(); // retry once after removing stale lock
  }
}
