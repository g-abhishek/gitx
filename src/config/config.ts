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

    if (!isGitxConfig(parsed)) {
      throw new GitxError(`Invalid config in ${filename}.`, { exitCode: 2 });
    }

    return parsed;
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

