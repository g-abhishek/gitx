import type { GitxConfig } from "../types/config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isGitxConfig(value: unknown): value is GitxConfig {
  if (!isRecord(value)) return false;
  const providers = value["providers"];
  const defaultBranch = value["defaultBranch"];

  if (!isRecord(providers)) return false;

  const allowed = new Set(["github", "gitlab", "azure"]);
  for (const [k, v] of Object.entries(providers)) {
    if (!allowed.has(k)) return false;
    if (!isRecord(v)) return false;
    if (typeof v["token"] !== "string" || String(v["token"]).trim().length === 0) return false;
  }

  const branchOk =
    defaultBranch === undefined ||
    (typeof defaultBranch === "string" && defaultBranch.trim().length > 0 && !defaultBranch.includes(" "));

  return branchOk;
}
