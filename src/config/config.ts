import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitxConfig } from "../types/config.js";
import { GitxError } from "../utils/errors.js";
import { isGitxConfig } from "./schema.js";

export const CONFIG_FILES = ["gitx.config.json", ".gitxrc"] as const;

export async function loadConfig(cwd = process.cwd()): Promise<GitxConfig> {
  for (const filename of CONFIG_FILES) {
    const fullPath = resolve(cwd, filename);
    if (!(await exists(fullPath))) continue;

    const raw = await readFile(fullPath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    // Back-compat for early v0.1 config shape: { provider, token, defaultBranch, repo? }
    const migrated = migrateLegacyConfig(parsed);

    if (!isGitxConfig(migrated)) {
      throw new GitxError(`Invalid config in ${filename}.`, { exitCode: 2 });
    }

    if (Object.keys(migrated.providers).length === 0) {
      throw new GitxError("No providers configured. Run `gitx init`.", { exitCode: 2 });
    }

    return migrated;
  }

  throw new GitxError("No gitx config found. Run `gitx init` first.", { exitCode: 2 });
}

export async function saveConfig(config: GitxConfig, cwd = process.cwd()): Promise<void> {
  const fullPath = resolve(cwd, "gitx.config.json");
  const contents = JSON.stringify(config, null, 2) + "\n";
  await writeFile(fullPath, contents, "utf8");
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
