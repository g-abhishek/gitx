/**
 * Config system — single source of truth: ~/.gitxrc
 *
 * All reads and writes go to exactly one file: ~/.gitxrc
 * No local project-level config files are searched or created.
 * This eliminates the class of bugs where a stale local config
 * silently shadows the global one.
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { GitxConfig } from "../types/config.js";
import { GitxError } from "../utils/errors.js";
import { isGitxConfig } from "./schema.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/** The one and only config file path. Always ~/.gitxrc */
export function getConfigPath(): string {
  const home = homedir();
  if (!home) throw new GitxError("Could not determine home directory.", { exitCode: 2 });
  return resolve(home, ".gitxrc");
}

/** Load config from ~/.gitxrc */
export async function loadConfig(_cwd?: string): Promise<GitxConfig> {
  const path = getConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new GitxError(
      `No gitx config found at ${path}. Run \`gitx init\` to set up your credentials.`,
      { exitCode: 2 }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GitxError(`Config file at ${path} is not valid JSON. Fix or delete it and re-run \`gitx init\`.`, { exitCode: 2 });
  }

  const migrated = migrateLegacyConfig(parsed);
  if (!isGitxConfig(migrated)) {
    throw new GitxError(`Config at ${path} has an unexpected structure. Re-run \`gitx init\`.`, { exitCode: 2 });
  }
  return migrated;
}

/** Save config to ~/.gitxrc. Returns the path written. */
export async function saveConfig(config: GitxConfig, _cwd?: string): Promise<string> {
  const path = getConfigPath();
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return path;
}

// ─── Legacy compat (kept so init.ts still compiles) ──────────────────────────

/** @deprecated Use saveConfig — writes to ~/.gitxrc */
export async function saveLocalConfig(config: GitxConfig, _cwd?: string): Promise<void> {
  await saveConfig(config);
}

/** @deprecated Use getConfigPath */
export function getGlobalConfigPath(): string {
  return getConfigPath();
}

/** @deprecated No longer needed — always returns getConfigPath() */
export async function findConfigPath(_cwd?: string): Promise<string> {
  return getConfigPath();
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Migrate old config formats to the current structure.
 *
 * Handles two legacy shapes:
 * 1. Single git-provider top-level:  { provider: "github", token: "..." }
 *    → { providers: { github: { token } } }
 *
 * 2. Old single AI config:  { ai: { provider: "claude", apiKey: "..." } }
 *    → { aiProviders: { claude: { apiKey } }, defaultAiProvider: "claude" }
 *    (and removes the old `ai` field)
 */
function migrateLegacyConfig(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const rec = { ...(value as Record<string, unknown>) };

  // 1. Migrate flat single-provider format → providers object
  if (!(typeof rec["providers"] === "object" && rec["providers"] !== null)) {
    const provider = rec["provider"];
    const token = rec["token"];
    const defaultBranch = rec["defaultBranch"];
    if (
      (provider === "github" || provider === "gitlab" || provider === "azure") &&
      typeof token === "string" &&
      token.trim().length > 0
    ) {
      return {
        providers: { [provider as string]: { token } },
        ...(typeof defaultBranch === "string" ? { defaultBranch } : {}),
      };
    }
  }

  // 2. Migrate old ai: { provider, apiKey } → aiProviders + defaultAiProvider
  if (rec["ai"] && !rec["aiProviders"]) {
    const ai = rec["ai"] as Record<string, unknown>;
    const aiProv = ai["provider"];
    const aiKey = ai["apiKey"];
    const aiModel = ai["model"];
    if (typeof aiProv === "string") {
      rec["aiProviders"] = {
        [aiProv]: {
          ...(typeof aiKey === "string" && aiKey.trim() ? { apiKey: aiKey } : {}),
          ...(typeof aiModel === "string" && aiModel.trim() ? { model: aiModel } : {}),
        },
      };
      rec["defaultAiProvider"] = aiProv;
      delete rec["ai"];
    }
  }

  return rec;
}
