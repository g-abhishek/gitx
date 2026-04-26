import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { GitxConfig } from "../types/config.js";
import { GitxError } from "../utils/errors.js";
import { isGitxConfig } from "./schema.js";

export const CONFIG_FILES = ["gitx.config.json", ".gitxrc"] as const;

export async function loadConfig(cwd = process.cwd()): Promise<GitxConfig> {
  const path = await findConfigPath(cwd);
  if (!path) {
    throw new GitxError(
      "No gitx config found. Run `gitx init` first (writes ~/.gitxrc), or add gitx.config.json/.gitxrc in your repo.",
      { exitCode: 2 },
    );
  }
  return readConfigFile(path);
}

export async function saveConfig(config: GitxConfig, cwd = process.cwd()): Promise<void> {
  // Default to global config for a smoother UX: `gitx init` once, then run gitx anywhere.
  const fullPath = getGlobalConfigPath();
  const contents = JSON.stringify(config, null, 2) + "\n";
  await writeFile(fullPath, contents, "utf8");
}

export async function saveLocalConfig(config: GitxConfig, cwd = process.cwd()): Promise<void> {
  const fullPath = resolve(cwd, "gitx.config.json");
  const contents = JSON.stringify(config, null, 2) + "\n";
  await writeFile(fullPath, contents, "utf8");
}

export function getGlobalConfigPath(): string {
  return resolve(getHomeDir(), ".gitxrc");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readConfigFile(path: string): Promise<GitxConfig> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const migrated = migrateLegacyConfig(parsed);

  if (!isGitxConfig(migrated)) {
    throw new GitxError(`Invalid config in ${path}.`, { exitCode: 2 });
  }

  if (Object.keys(migrated.providers).length === 0) {
    throw new GitxError("No providers configured. Run `gitx init`.", { exitCode: 2 });
  }

  return migrated;
}

function migrateLegacyConfig(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (isRecord(value["providers"])) return value;

  const provider = value["provider"];
  const token = value["token"];
  const defaultBranch = value["defaultBranch"];

  if (
    (provider === "github" || provider === "gitlab" || provider === "azure") &&
    typeof token === "string" &&
    token.trim().length > 0
  ) {
    return {
      providers: { [provider]: { token } },
      ...(typeof defaultBranch === "string" ? { defaultBranch } : {})
    };
  }

  return value;
}

export async function findConfigPath(cwd = process.cwd()): Promise<string | undefined> {
  // 1) Search upward from cwd for project-level config
  let current = resolve(cwd);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const filename of CONFIG_FILES) {
      const fullPath = resolve(current, filename);
      if (await exists(fullPath)) return fullPath;
    }

    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  // 2) Fallback to global config in home directory
  const home = getHomeDir();
  const globalRc = resolve(home, ".gitxrc");
  if (await exists(globalRc)) return globalRc;
  const globalJson = resolve(home, "gitx.config.json");
  if (await exists(globalJson)) return globalJson;

  return undefined;
}

function getHomeDir(): string {
  const home = homedir();
  if (!home) throw new GitxError("Could not determine home directory for config.", { exitCode: 2 });
  return home;
}
