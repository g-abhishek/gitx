/**
 * Claude AI integration via the Anthropic Messages API.
 *
 * Authentication: reads ANTHROPIC_API_KEY from the environment.
 * Model:          defaults to claude-3-5-haiku-20241022 (fast, affordable).
 *                 Override via GITX_AI_MODEL env var.
 *
 * All methods send a structured system prompt and parse the JSON response.
 * If parsing fails we fall back gracefully rather than crashing.
 */

import axios, { isAxiosError } from "axios";
import { GitxError } from "../utils/errors.js";
import type {
  AiAnalyzeTaskResponse,
  AiClient,
  AiGenerateDiffsResponse,
  AiGeneratePlanResponse,
  AiSuggestFixesResponse,
  AiSummarizeChangesResponse,
} from "./types.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-3-5-haiku-20241022";
const MAX_TOKENS = 4096;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) {
    throw new GitxError(
      "ANTHROPIC_API_KEY environment variable is not set. " +
        "Export it before running gitx: export ANTHROPIC_API_KEY=sk-ant-...",
      { exitCode: 2 }
    );
  }
  return key;
}

function getModel(): string {
  return process.env["GITX_AI_MODEL"] ?? DEFAULT_MODEL;
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface ClaudeRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: ClaudeMessage[];
}

interface ClaudeResponseBody {
  content: Array<{ type: string; text: string }>;
}

async function callClaude(system: string, userPrompt: string): Promise<string> {
  const apiKey = getApiKey();

  const body: ClaudeRequestBody = {
    model: getModel(),
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userPrompt }],
  };

  try {
    const { data } = await axios.post<ClaudeResponseBody>(ANTHROPIC_API, body, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 60_000,
    });

    const text = data.content.find((c) => c.type === "text")?.text ?? "";
    return text;
  } catch (err) {
    if (isAxiosError(err)) {
      const status = err.response?.status;
      const msg = (err.response?.data as Record<string, unknown> | undefined)?.error ?? err.message;
      if (status === 401) {
        throw new GitxError(
          "Anthropic API authentication failed. Check ANTHROPIC_API_KEY.",
          { exitCode: 1, cause: err }
        );
      }
      throw new GitxError(
        `Anthropic API error (${status ?? "network"}): ${String(msg)}`,
        { exitCode: 1, cause: err }
      );
    }
    throw new GitxError(`Unexpected AI error: ${String(err)}`, { exitCode: 1, cause: err });
  }
}

/**
 * Extract JSON from a Claude response that may include markdown code fences.
 * Claude sometimes wraps JSON in ```json ... ``` blocks.
 */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  // Find first { or [ and last } or ]
  const start = text.search(/[{[]/);
  const endBrace = text.lastIndexOf("}");
  const endBracket = text.lastIndexOf("]");
  const end = Math.max(endBrace, endBracket);
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text.trim();
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    return fallback;
  }
}

// ─── ClaudeAi ─────────────────────────────────────────────────────────────────

export class ClaudeAi implements AiClient {
  /**
   * Check whether the API key is available without making a network call.
   */
  static isAvailable(): boolean {
    return Boolean(process.env["ANTHROPIC_API_KEY"]);
  }

  async analyzeTask(input: string): Promise<AiAnalyzeTaskResponse> {
    const system = `You are an expert software engineer. Analyze the given development task and respond with ONLY valid JSON matching this exact structure (no prose, no markdown, just raw JSON):
{
  "task": "<the original task string>",
  "intent": "<one of: refactor | bugfix | feature | chore | unknown>",
  "summary": "<one sentence explaining what needs to be done>",
  "assumptions": ["<assumption 1>", "<assumption 2>"],
  "risks": ["<risk 1>", "<risk 2>"]
}`;

    const text = await callClaude(system, `Task: ${input}`);
    const parsed = parseJson<Partial<AiAnalyzeTaskResponse>>(text, {});
    return {
      task: input,
      intent: (parsed.intent as AiAnalyzeTaskResponse["intent"]) ?? "unknown",
      summary: parsed.summary ?? "Unable to analyze task.",
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    };
  }

  async generatePlan(context: unknown): Promise<AiGeneratePlanResponse> {
    const ctx = context as {
      task?: string;
      analysis?: AiAnalyzeTaskResponse;
      repoFiles?: string[];
      fileContents?: Record<string, string>;
    };

    const taskDesc = ctx.task ?? "Unknown task";
    const analysisSummary = ctx.analysis?.summary ?? "";
    const fileList = ctx.repoFiles?.slice(0, 50).join("\n") ?? "(not provided)";
    const fileContentsSection =
      ctx.fileContents && Object.keys(ctx.fileContents).length > 0
        ? `\n\nRelevant file contents:\n${Object.entries(ctx.fileContents)
            .map(([p, c]) => `--- ${p} ---\n${c}`)
            .join("\n\n")}`
        : "";

    const system = `You are an expert software engineer creating a step-by-step implementation plan. Respond with ONLY valid JSON:
{
  "steps": [
    { "id": "step-1", "title": "<short title>", "description": "<detailed description of what to change and why>" },
    { "id": "step-2", "title": "<short title>", "description": "<detailed description>" }
  ]
}
Keep steps atomic and ordered. Each step should touch one logical concern.`;

    const userPrompt = `Task: ${taskDesc}
Analysis: ${analysisSummary}
Repo files (top 50):
${fileList}${fileContentsSection}`;

    const text = await callClaude(system, userPrompt);
    const parsed = parseJson<Partial<AiGeneratePlanResponse>>(text, { steps: [] });
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];

    if (steps.length === 0) {
      return {
        steps: [
          { id: "step-1", title: "Analyze & implement", description: taskDesc },
        ],
      };
    }
    return { steps };
  }

  async generateDiffs(step: unknown): Promise<AiGenerateDiffsResponse> {
    const s = step as {
      id?: string;
      title?: string;
      description?: string;
      task?: string;
      analysis?: AiAnalyzeTaskResponse;
      fileContents?: Record<string, string>;
    };

    const stepId = s.id ?? "step-1";
    const fileContentsSection =
      s.fileContents && Object.keys(s.fileContents).length > 0
        ? `\n\nCurrent file contents (apply changes to these):\n${Object.entries(s.fileContents)
            .map(([p, c]) => `--- ${p} ---\n${c}`)
            .join("\n\n")}`
        : "\n\n(No existing file contents provided — create new files as needed.)";

    const system = `You are an expert software engineer. Generate unified diffs for the given implementation step.

Respond with ONLY valid JSON:
{
  "stepId": "<step id>",
  "diffs": [
    {
      "path": "<relative file path>",
      "unifiedDiff": "<valid unified diff content starting with --- a/path and +++ b/path>"
    }
  ]
}

Rules for unified diffs:
- Start with: --- a/<path>\\n+++ b/<path>
- Use @@ -<start>,<count> +<start>,<count> @@ context headers
- Lines starting with ' ' are context (unchanged)
- Lines starting with '-' are removed
- Lines starting with '+' are added
- For new files use: --- /dev/null\\n+++ b/<path>
- For deleted files use: --- a/<path>\\n+++ /dev/null
- Always include 3 lines of context around changes
- Make minimal, precise changes`;

    const userPrompt = `Task: ${s.task ?? ""}
Step ID: ${stepId}
Step Title: ${s.title ?? ""}
Step Description: ${s.description ?? ""}${fileContentsSection}`;

    const text = await callClaude(system, userPrompt);
    const parsed = parseJson<Partial<AiGenerateDiffsResponse>>(text, { stepId, diffs: [] });
    return {
      stepId,
      diffs: Array.isArray(parsed.diffs) ? parsed.diffs : [],
    };
  }

  async summarizeChanges(diff: unknown): Promise<AiSummarizeChangesResponse> {
    const d = diff as {
      diffs?: AiGenerateDiffsResponse[];
      rawDiff?: string;
    };

    const diffContent =
      d.rawDiff ??
      (d.diffs ?? [])
        .flatMap((dr) => dr.diffs.map((f) => `File: ${f.path}\n${f.unifiedDiff}`))
        .join("\n\n") ??
      "(no diffs)";

    const system = `You are a technical writer. Summarize code changes for a pull request. Respond with ONLY valid JSON:
{
  "summary": "<2-3 sentence plain-English summary of what changed and why>",
  "filesChanged": [
    { "path": "<file path>", "changeType": "<add | modify | delete>" }
  ]
}`;

    const text = await callClaude(system, `Changes:\n${diffContent}`);
    const parsed = parseJson<Partial<AiSummarizeChangesResponse>>(text, {
      summary: "",
      filesChanged: [],
    });
    return {
      summary: parsed.summary ?? "Code changes applied.",
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
    };
  }

  async suggestFixes(comment: unknown): Promise<AiSuggestFixesResponse> {
    const c = comment as {
      comments?: Array<{ body: string; path?: string; line?: number; author?: string }>;
      prTitle?: string;
      prBody?: string;
      fileContents?: Record<string, string>;
    };

    const commentsText = (c.comments ?? [])
      .map(
        (co) =>
          `[${co.author ?? "reviewer"}${co.path ? ` on ${co.path}:${co.line ?? ""}` : ""}]: ${co.body}`
      )
      .join("\n\n");

    const fileContentsSection =
      c.fileContents && Object.keys(c.fileContents).length > 0
        ? `\n\nCurrent file contents:\n${Object.entries(c.fileContents)
            .map(([p, content]) => `--- ${p} ---\n${content}`)
            .join("\n\n")}`
        : "";

    const system = `You are an expert code reviewer suggesting fixes for pull request review comments. Respond with ONLY valid JSON:
{
  "suggestedEdits": [
    {
      "path": "<file path>",
      "rationale": "<why this change addresses the comment>",
      "unifiedDiff": "<valid unified diff>"
    }
  ]
}
If a comment doesn't require a code change, omit it from suggestedEdits.`;

    const userPrompt = `PR Title: ${c.prTitle ?? ""}
PR Body: ${c.prBody ?? ""}

Review Comments:
${commentsText}${fileContentsSection}`;

    const text = await callClaude(system, userPrompt);
    const parsed = parseJson<Partial<AiSuggestFixesResponse>>(text, { suggestedEdits: [] });
    return {
      suggestedEdits: Array.isArray(parsed.suggestedEdits) ? parsed.suggestedEdits : [],
    };
  }
}
