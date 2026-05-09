/**
 * OpenAiAi — OpenAI Chat Completions API integration.
 *
 * Authentication: OPENAI_API_KEY env var or stored config key.
 * Model:          defaults to gpt-4o. Override via GITX_AI_MODEL env var.
 *
 * All methods use the same structured JSON prompt pattern as ClaudeAi.
 */

import axios, { isAxiosError } from "axios";
import { GitxError } from "../utils/errors.js";
import type {
  AiAnalyzeTaskResponse,
  AiClient,
  AiGenerateDiffsResponse,
  AiGeneratePlanResponse,
  AiReviewPRResponse,
  AiSuggestFixesResponse,
  AiSummarizeChangesResponse,
} from "./types.js";

const OPENAI_API = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o";
const MAX_TOKENS = 4096;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getModel(override?: string): string {
  return process.env["GITX_AI_MODEL"] ?? override ?? DEFAULT_MODEL;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAiRequestBody {
  model: string;
  max_tokens: number;
  messages: ChatMessage[];
}

interface OpenAiResponseBody {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
}

async function callOpenAi(
  system: string,
  userPrompt: string,
  apiKey: string,
  model: string
): Promise<string> {
  const body: OpenAiRequestBody = {
    model,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
  };

  try {
    const { data } = await axios.post<OpenAiResponseBody>(OPENAI_API, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60_000,
    });

    return data.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    if (isAxiosError(err)) {
      const status = err.response?.status;
      const msg =
        (err.response?.data as Record<string, unknown> | undefined)?.error ??
        err.message;
      if (status === 401) {
        throw new GitxError(
          "OpenAI API authentication failed. Check OPENAI_API_KEY.",
          { exitCode: 1, cause: err }
        );
      }
      if (status === 429) {
        throw new GitxError(
          "OpenAI rate limit exceeded. Wait a moment and retry.",
          { exitCode: 1, cause: err }
        );
      }
      throw new GitxError(
        `OpenAI API error (${status ?? "network"}): ${String(msg)}`,
        { exitCode: 1, cause: err }
      );
    }
    throw new GitxError(`Unexpected OpenAI error: ${String(err)}`, {
      exitCode: 1,
      cause: err,
    });
  }
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.search(/[{[]/);
  const endBrace = text.lastIndexOf("}");
  const endBracket = text.lastIndexOf("]");
  const end = Math.max(endBrace, endBracket);
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    return fallback;
  }
}

// ─── OpenAiAi ─────────────────────────────────────────────────────────────────

export class OpenAiAi implements AiClient {
  private readonly apiKey: string;
  private readonly model: string;

  /**
   * @param apiKey  OpenAI API key. Falls back to OPENAI_API_KEY env var.
   * @param model   Model override. Falls back to GITX_AI_MODEL then gpt-4o.
   */
  constructor(apiKey?: string, model?: string) {
    const key = apiKey ?? process.env["OPENAI_API_KEY"];
    if (!key) {
      throw new GitxError(
        "No OpenAI API key available. Run `gitx config set openai` or set OPENAI_API_KEY.",
        { exitCode: 2 }
      );
    }
    this.apiKey = key;
    this.model = getModel(model);
  }

  /** Check whether an OpenAI API key is available without instantiating. */
  static isAvailable(key?: string): boolean {
    return Boolean(key ?? process.env["OPENAI_API_KEY"]);
  }

  async analyzeTask(input: string): Promise<AiAnalyzeTaskResponse> {
    const system = `You are an expert software engineer. Analyze the given development task and respond with ONLY valid JSON matching this exact structure (no prose, no markdown):
{
  "task": "<the original task string>",
  "intent": "<one of: refactor | bugfix | feature | chore | unknown>",
  "summary": "<one sentence explaining what needs to be done>",
  "assumptions": ["<assumption 1>", "<assumption 2>"],
  "risks": ["<risk 1>", "<risk 2>"]
}`;

    const text = await callOpenAi(system, `Task: ${input}`, this.apiKey, this.model);
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
    { "id": "step-1", "title": "<short title>", "description": "<detailed description>" }
  ]
}
Keep steps atomic and ordered. Each step should touch one logical concern.`;

    const userPrompt = `Task: ${taskDesc}
Analysis: ${analysisSummary}
Repo files (top 50):
${fileList}${fileContentsSection}`;

    const text = await callOpenAi(system, userPrompt, this.apiKey, this.model);
    const parsed = parseJson<Partial<AiGeneratePlanResponse>>(text, { steps: [] });
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];

    if (steps.length === 0) {
      return { steps: [{ id: "step-1", title: "Analyze & implement", description: taskDesc }] };
    }
    return { steps };
  }

  async generateDiffs(step: unknown): Promise<AiGenerateDiffsResponse> {
    const s = step as {
      id?: string;
      title?: string;
      description?: string;
      task?: string;
      fileContents?: Record<string, string>;
    };

    const stepId = s.id ?? "step-1";
    const fileContentsSection =
      s.fileContents && Object.keys(s.fileContents).length > 0
        ? `\n\nCurrent file contents:\n${Object.entries(s.fileContents)
            .map(([p, c]) => `--- ${p} ---\n${c}`)
            .join("\n\n")}`
        : "\n\n(No existing file contents — create new files as needed.)";

    const system = `You are an expert software engineer. Generate unified diffs for the given implementation step.
Respond with ONLY valid JSON:
{
  "stepId": "<step id>",
  "diffs": [
    {
      "path": "<relative file path>",
      "unifiedDiff": "<valid unified diff starting with --- a/path and +++ b/path>"
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
- Always include 3 lines of context around changes`;

    const userPrompt = `Task: ${s.task ?? ""}
Step ID: ${stepId}
Step Title: ${s.title ?? ""}
Step Description: ${s.description ?? ""}${fileContentsSection}`;

    const text = await callOpenAi(system, userPrompt, this.apiKey, this.model);
    const parsed = parseJson<Partial<AiGenerateDiffsResponse>>(text, { stepId, diffs: [] });
    return {
      stepId,
      diffs: Array.isArray(parsed.diffs) ? parsed.diffs : [],
    };
  }

  async summarizeChanges(diff: unknown): Promise<AiSummarizeChangesResponse> {
    const d = diff as { diffs?: AiGenerateDiffsResponse[]; rawDiff?: string };
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

    const text = await callOpenAi(system, `Changes:\n${diffContent}`, this.apiKey, this.model);
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

    const text = await callOpenAi(system, userPrompt, this.apiKey, this.model);
    const parsed = parseJson<Partial<AiSuggestFixesResponse>>(text, { suggestedEdits: [] });
    return {
      suggestedEdits: Array.isArray(parsed.suggestedEdits) ? parsed.suggestedEdits : [],
    };
  }

  async reviewPR(context: unknown): Promise<AiReviewPRResponse> {
    const ctx = context as {
      prTitle?: string;
      prBody?: string;
      diff?: string;
      comments?: Array<{ body: string; author: string; path?: string }>;
    };

    const diffSection = ctx.diff
      ? `\n\nDiff (unified):\n${ctx.diff.slice(0, 8000)}`
      : "";
    const commentsSection =
      ctx.comments && ctx.comments.length > 0
        ? `\n\nExisting review comments:\n${ctx.comments
            .map((c) => `[${c.author}${c.path ? ` @ ${c.path}` : ""}]: ${c.body}`)
            .join("\n")}`
        : "";

    const system = `You are an expert code reviewer. Review the given pull request thoroughly and respond with ONLY valid JSON:
{
  "summary": "<2-4 sentence overall assessment>",
  "issues": [
    { "severity": "<critical|warning|suggestion>", "description": "<specific issue>", "file": "<optional file>", "line": null }
  ],
  "positives": ["<good thing 1>", "<good thing 2>"],
  "verdict": "<approve|request_changes|comment>"
}

Severity guide:
- critical: bugs, security issues, data loss risk
- warning: code quality, performance, missing error handling
- suggestion: style, naming, minor improvements`;

    const userPrompt = `PR Title: ${ctx.prTitle ?? ""}
PR Description: ${ctx.prBody ?? ""}${diffSection}${commentsSection}`;

    const text = await callOpenAi(system, userPrompt, this.apiKey, this.model);
    const parsed = parseJson<Partial<AiReviewPRResponse>>(text, {
      summary: "",
      issues: [],
      positives: [],
      verdict: "comment",
    });

    return {
      summary: parsed.summary ?? "Review could not be generated.",
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      positives: Array.isArray(parsed.positives) ? parsed.positives : [],
      verdict: (["approve", "request_changes", "comment"].includes(parsed.verdict ?? ""))
        ? (parsed.verdict as AiReviewPRResponse["verdict"])
        : "comment",
    };
  }
}
