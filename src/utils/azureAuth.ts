/**
 * Azure DevOps GCM (Git Credential Manager) authentication helpers.
 *
 * Instead of a PAT token, this module uses `git credential fill` to obtain a
 * short-lived OAuth Bearer token managed by GCM. No token is ever stored in
 * the gitx config file — GCM is the secure, OS-level credential store.
 *
 * Prerequisites (run once):
 *   git config --global credential.azreposCredentialType oauth
 *   git config --global credential.https://dev.azure.com.useHttpPath true
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run `git <args>` and return stdout as a string.
 * Uses spawn so we can write to stdin (needed for `git credential fill`).
 */
function spawnGit(args: string[], stdinData?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args[0] ?? ""} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      } else {
        resolve(stdout);
      }
    });

    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GcmVerifyResult {
  ok: boolean;
  issues: string[];
  fixes: string[];
}

// ─── In-memory token cache ────────────────────────────────────────────────────
// Tokens are cached for the lifetime of the current process. GCM handles
// background refresh; gitx just re-reads on the next process invocation.
const tokenCache = new Map<string, string>();

// ─── Token fetch ──────────────────────────────────────────────────────────────

/**
 * Fetch an OAuth Bearer token for the given Azure DevOps org via GCM.
 *
 * Uses `git credential fill` which reads from the OS credential store
 * (Windows Credential Manager / macOS Keychain / GNOME Keyring).
 * Caches the result in-memory so repeated calls within the same process are
 * instant (< 1 ms vs ~5 ms for the subprocess round-trip).
 *
 * @param org  Azure DevOps org name, e.g. "GoFynd" or "mycompany"
 */
export async function getTokenViaGcm(org: string): Promise<string> {
  const cached = tokenCache.get(org);
  if (cached) return cached;

  const input = `protocol=https\nhost=dev.azure.com\npath=${org}\n\n`;

  let stdout: string;
  try {
    stdout = await spawnGit(["credential", "fill"], input);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GCM token fetch failed for org "${org}": ${msg}\n` +
      `Make sure Git Credential Manager is installed and the following git config is set:\n` +
      `  git config --global credential.azreposCredentialType oauth\n` +
      `  git config --global credential.https://dev.azure.com.useHttpPath true\n` +
      `Then trigger a login by running any authenticated git command against the repo.`
    );
  }

  // Parse "password=<token>" line from git credential output
  const match = stdout.match(/^password=(.+)$/m);
  if (!match?.[1]) {
    throw new Error(
      `GCM returned no token for org "${org}".\n` +
      `Try running:  git pull  (to trigger a fresh Azure DevOps login via browser)`
    );
  }

  const token = match[1].trim();
  tokenCache.set(org, token);
  return token;
}

/**
 * Clear the in-memory token cache for the given org (or all orgs).
 * Useful after a 401 response — forces a fresh fetch on the next call.
 */
export function invalidateGcmCache(org?: string): void {
  if (org) {
    tokenCache.delete(org);
  } else {
    tokenCache.clear();
  }
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

/**
 * Decode a JWT token (without verifying its signature) and return the
 * expiry Unix timestamp from the `exp` claim, or `null` if not present.
 *
 * Azure DevOps OAuth access tokens typically expire in ~1 hour.
 * GCM handles refresh silently before the token expires.
 */
export function decodeJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1].padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), "=");
    const payload = Buffer.from(padded, "base64").toString("utf8");
    const json = JSON.parse(payload) as { exp?: number };
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

// ─── GCM setup verification ───────────────────────────────────────────────────

/**
 * Verify that GCM is correctly configured for Azure DevOps and that a token
 * can actually be fetched for the given org.
 *
 * Returns `{ ok: true }` when everything is fine, or `{ ok: false }` with a
 * list of `issues` (human-readable) and `fixes` (shell commands to run).
 *
 * @param org  Azure DevOps org name, e.g. "GoFynd"
 */
export async function verifyGcmSetup(org: string): Promise<GcmVerifyResult> {
  const issues: string[] = [];
  const fixes: string[] = [];

  // 1. Check: credential.https://dev.azure.com.useHttpPath = true
  try {
    const { stdout } = await execFileAsync("git", [
      "config", "--global", "credential.https://dev.azure.com.useHttpPath",
    ]);
    if (stdout.trim() !== "true") {
      issues.push("`credential.https://dev.azure.com.useHttpPath` is not set to `true`");
      fixes.push("git config --global credential.https://dev.azure.com.useHttpPath true");
    }
  } catch {
    issues.push("`credential.https://dev.azure.com.useHttpPath` is not configured");
    fixes.push("git config --global credential.https://dev.azure.com.useHttpPath true");
  }

  // 2. Check: credential.azreposCredentialType = oauth
  try {
    const { stdout } = await execFileAsync("git", [
      "config", "--global", "credential.azreposCredentialType",
    ]);
    if (stdout.trim() !== "oauth") {
      issues.push("`credential.azreposCredentialType` is not set to `oauth`");
      fixes.push("git config --global credential.azreposCredentialType oauth");
    }
  } catch {
    issues.push("`credential.azreposCredentialType` is not configured");
    fixes.push("git config --global credential.azreposCredentialType oauth");
  }

  // 3. If git config looks good, do a live token fetch
  if (issues.length === 0) {
    try {
      invalidateGcmCache(org); // always do a fresh fetch during verification
      await getTokenViaGcm(org);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      issues.push(`Token fetch failed: ${msg}`);
      fixes.push("git pull  (to trigger a fresh Azure DevOps login via browser)");
    }
  }

  return { ok: issues.length === 0, issues, fixes };
}
