import type { GitxConfig } from "../types/config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isGitxConfig(value: unknown): value is GitxConfig {
  if (!isRecord(value)) return false;
  const provider = value["provider"];
  const token = value["token"];
  const repo = value["repo"];
  const defaultBranch = value["defaultBranch"];

  const providerOk = provider === "github" || provider === "gitlab" || provider === "azure";
  const tokenOk = typeof token === "string" && token.length > 0;
  const repoOk = typeof repo === "string" && repo.includes("/") && !repo.includes(" ");
  const branchOk = typeof defaultBranch === "string" && defaultBranch.length > 0;

  return providerOk && tokenOk && repoOk && branchOk;
}

