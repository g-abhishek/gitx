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
  AiReviewPRResponse,
  AiSuggestFixesResponse,
  AiSummarizeChangesResponse,
} from "./types.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-3-5-haiku-20241022";
const MAX_TOKENS = 4096;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getModel(override?: string): string {
  return process.env["GITX_AI_MODEL"] ?? override ?? DEFAULT_MODEL;
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

async function callClaude(system: string, userPrompt: string, apiKey: string, model: string): Promise<string> {
  const body: ClaudeRequestBody = {
    model,
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
  private readonly apiKey: string;
  private readonly model: string;

  /**
   * @param apiKey  Anthropic API key. Falls back to ANTHROPIC_API_KEY env var.
   * @param model   Model override. Falls back to GITX_AI_MODEL env var then default.
   */
  constructor(apiKey?: string, model?: string) {
    const key = apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!key) {
      throw new GitxError(
        "No Anthropic API key available. Run `gitx config setup` or set ANTHROPIC_API_KEY.",
        { exitCode: 2 }
      );
    }
    this.apiKey = key;
    this.model = getModel(model);
  }

  /** Check whether an API key is available without instantiating the class. */
  static isAvailable(key?: string): boolean {
    return Boolean(key ?? process.env["ANTHROPIC_API_KEY"]);
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

    const text = await callClaude(system, `Task: ${input}`, this.apiKey, this.model);
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

    const text = await callClaude(system, userPrompt, this.apiKey, this.model);
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

    const text = await callClaude(system, userPrompt, this.apiKey, this.model);
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

    const text = await callClaude(system, `Changes:\n${diffContent}`, this.apiKey, this.model);
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

    const text = await callClaude(system, userPrompt, this.apiKey, this.model);
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
        ? `\n\nExisting review comments:\n${ctx.comments.map((c) => `[${c.author}${c.path ? ` @ ${c.path}` : ""}]: ${c.body}`).join("\n")}`
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

    const text = await callClaude(system, userPrompt, this.apiKey, this.model);
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

  async generatePrContent(commits: string[], diff: string, stat?: string): Promise<import("./types.js").AiPrContentResponse> {
    const system = `You are an expert software engineer writing pull request descriptions.
You are given a list of commits on the branch and the unified diff of all changes.

The input may contain:
  - "=== Changed files (complete list) ===" — the full --stat summary of every file touched
  - "=== Detailed diff ===" — the actual patch (may be truncated for large changesets)

When a file list is present, use it as the authoritative source of ALL changed files.
Do not ignore files that appear in the list but are absent from the truncated diff.

Produce a clear, informative PR title and description:

Rules:
- title: short, human-readable, present-tense (e.g. "Add user authentication flow")
  No conventional-commit prefix needed. Max 72 chars.
- body: 2-4 sentences describing WHAT changed and WHY. Cover ALL files from the list.
  Plain English. Do not repeat the title. Do not use bullet points.

Respond with ONLY valid JSON (no markdown fences):
{"title":"<PR title>","body":"<PR description>"}`;

    const commitList = commits.slice(0, 20).join("\n");
    const diffSection = stat
      ? `=== Changed files (complete list) ===\n${stat}\n\n=== Detailed diff ===\n${diff.slice(0, 16000)}`
      : `Diff:\n${diff.slice(0, 16000)}`;
    const userPrompt = `Commits on this branch:\n${commitList}\n\n${diffSection}`;
    const text = await callClaude(system, userPrompt, this.apiKey, this.model);
    const parsed = parseJson<Partial<import("./types.js").AiPrContentResponse>>(text, {});
    return {
      title: parsed.title?.trim() ?? "Update branch",
      body: parsed.body?.trim() ?? "",
    };
  }

  async resolveConflict(filePath: string, conflictContent: string): Promise<import("./types.js").AiConflictResolutionResponse> {
    const system = `You are an expert software engineer resolving git merge conflicts.

The file contains standard git conflict markers:
  <<<<<<< HEAD  (or <<<<<<< ours)   — changes on the current branch
  =======                            — separator
  >>>>>>> branch  (or >>>>>>> theirs) — incoming changes being merged/rebased

Your task:
1. Understand BOTH sides of every conflict in the file.
2. Produce a single correct version that preserves the intent of BOTH changes where possible.
3. If the two sides are genuinely contradictory and cannot be safely merged, set confidence to "low".

Rules:
- Remove ALL conflict markers (<<<<<<, =======, >>>>>>>) from the output.
- Do NOT add comments explaining what you did.
- Keep all non-conflicting code exactly as-is.
- The output must be syntactically valid for the file type.

Respond with ONLY valid JSON (no markdown fences):
{"resolved":"<full resolved file content>","confidence":"high|low","explanation":"<one sentence>"}`;

    const userPrompt = `File: ${filePath}\n\n${conflictContent.slice(0, 20000)}`;
    const text = await callClaude(system, userPrompt, this.apiKey, this.model);
    const parsed = parseJson<Partial<import("./types.js").AiConflictResolutionResponse>>(text, {});
    return {
      resolved: parsed.resolved ?? conflictContent,
      confidence: parsed.confidence === "low" ? "low" : "high",
      explanation: parsed.explanation?.trim() ?? "Conflict resolved.",
    };
  }
  async generateCommitMessage(diff: string): Promise<import("./types.js").AiCommitMessageResponse> {
    const system = `You are an expert software engineer writing git commit messages.
You receive either a plain unified diff OR a structured input with:
  - "=== Changed files (complete list) ===" — the full --stat summary of every file touched
  - "=== Detailed diff ===" — the actual patch (may be truncated for large changesets)

When a file list is present, use it as the authoritative source of ALL changes.
Do not ignore files that appear in the list but are missing from the truncated diff.

Produce ONE CONVENTIONAL COMMIT covering all the changes:

Rules:
- subject: "<type>(<scope>): <imperative description>"
  - type: feat | fix | refactor | chore | docs | test | perf | ci | style | build
  - scope: the primary area affected; omit if changes span many unrelated areas
  - description: imperative mood, no period, 72 chars max for the whole subject line
  - if several distinct features or fixes are present, pick the most impactful for the subject
- body: cover EVERY significant change visible in the file list. For each distinct change,
  one sentence on what was done and why. Plain English, no bullet lists, no repetition of the subject.

Respond with ONLY valid JSON (no markdown fences):
{"subject":"<subject line>","body":"<body covering all changes, or empty string>"}`;

    const text = await callClaude(system, `Diff:\n${diff.slice(0, 20000)}`, this.apiKey, this.model);
    const parsed = parseJson<Partial<import("./types.js").AiCommitMessageResponse>>(text, {});
    return {
      subject: parsed.subject?.trim() ?? "chore: update files",
      body: parsed.body?.trim() || undefined,
    };
  }

  async reviewPRDetailed(
    context: Parameters<import("./types.js").AiClient["reviewPRDetailed"]>[0]
  ): Promise<import("./types.js").AiDetailedReviewResponse> {
    const { buildSeniorReviewSystem, buildSeniorReviewPrompt, parseSeniorReview } = await import("./reviewHelpers.js");
    const text = await callClaude(
      buildSeniorReviewSystem(),
      buildSeniorReviewPrompt(context),
      this.apiKey,
      this.model
    );
    return parseSeniorReview(text);
  }

  async generateFix(
    context: Parameters<import("./types.js").AiClient["generateFix"]>[0]
  ): Promise<import("./types.js").AiFixResponse> {
    const { buildFixSystem, buildFixPrompt, parseFixResponse } = await import("./reviewHelpers.js");
    const text = await callClaude(
      buildFixSystem(),
      buildFixPrompt(context),
      this.apiKey,
      this.model
    );
    return parseFixResponse(text, context.filePath, context.line);
  }

  async ask(
    question: string,
    context: import("./types.js").AiAskContext
  ): Promise<import("./types.js").AiAskResponse> {
    const { buildAskSystem, buildAskPrompt, parseAskResponse } = await import("./reviewHelpers.js");
    const text = await callClaude(buildAskSystem(), buildAskPrompt(question, context), this.apiKey, this.model);
    return parseAskResponse(text);
  }
}
