import type { GitxConfig } from "../types/config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const ALLOWED_GIT_PROVIDERS = new Set(["github", "gitlab", "azure"]);
const ALLOWED_AI_PROVIDERS = new Set(["claude", "openai", "claude-cli"]);

export function isGitxConfig(value: unknown): value is GitxConfig {
  if (!isRecord(value)) return false;

  // providers must be an object (can be empty for fresh installs)
  const providers = value["providers"];
  if (!isRecord(providers)) return false;

  for (const [k, v] of Object.entries(providers)) {
    if (!ALLOWED_GIT_PROVIDERS.has(k)) return false;
    if (!isRecord(v)) return false;

    const authMethod = v["authMethod"];
    if (authMethod !== undefined && authMethod !== "pat" && authMethod !== "gcm") return false;

    if (authMethod === "gcm") {
      // GCM entries have no stored token — that is expected and valid
      continue;
    }

    // PAT (default): token must be a non-empty string
    if (typeof v["token"] !== "string" || String(v["token"]).trim().length === 0) return false;
  }

  // aiProviders is optional — validate each entry if present
  const aiProviders = value["aiProviders"];
  if (aiProviders !== undefined) {
    if (!isRecord(aiProviders)) return false;
    for (const [k, entry] of Object.entries(aiProviders)) {
      if (!ALLOWED_AI_PROVIDERS.has(k)) return false;
      if (!isRecord(entry)) return false;
      // claude-cli has no apiKey; others require one if present
      if (k !== "claude-cli") {
        const apiKey = entry["apiKey"];
        if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.trim().length === 0)) {
          return false;
        }
      }
      const model = entry["model"];
      if (model !== undefined && typeof model !== "string") return false;
    }
  }

  // defaultAiProvider is optional but must be a known kind
  const defaultAiProvider = value["defaultAiProvider"];
  if (defaultAiProvider !== undefined && !ALLOWED_AI_PROVIDERS.has(String(defaultAiProvider))) {
    return false;
  }

  // Legacy ai field — optional, validated loosely for compat
  const ai = value["ai"];
  if (ai !== undefined) {
    if (!isRecord(ai)) return false;
    if (!ALLOWED_AI_PROVIDERS.has(String(ai["provider"]))) return false;
    // apiKey optional for claude-cli
    if (ai["provider"] !== "claude-cli") {
      const apiKey = ai["apiKey"];
      if (apiKey !== undefined && (typeof apiKey !== "string" || String(apiKey).trim().length === 0)) {
        return false;
      }
    }
  }

  // defaultBranch is optional
  const defaultBranch = value["defaultBranch"];
  if (
    defaultBranch !== undefined &&
    (typeof defaultBranch !== "string" || defaultBranch.trim().length === 0 || defaultBranch.includes(" "))
  ) {
    return false;
  }

  return true;
}
