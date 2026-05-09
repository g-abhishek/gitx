/**
 * ClaudeCliAi — uses the locally installed `claude` CLI (Claude Code)
 * as an AI backend. No API key required; uses the user's existing Claude login.
 *
 * Detection: `claude --version`
 * Invocation: `claude -p "<combined system+user prompt>"`
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function callClaudeCli(
  systemPrompt: string,
  userPrompt: string,
  opts: { timeoutMs?: number; maxOutputChars?: number } = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxOutputChars = opts.maxOutputChars ?? 12_000;
  const combined = `<system>\n${systemPrompt}\n</system>\n\n${userPrompt}`;

  let stdout: string;
  try {
    const result = await execFileAsync("claude", ["-p", combined], {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string; killed?: boolean };
    if (e.code === "ENOENT") {
      throw new GitxError(
        "Claude CLI not found. Install Claude Code from https://claude.ai/download",
        { exitCode: 2 }
      );
    }
    if (e.killed) {
      const secs = Math.round(timeoutMs / 1000);
      throw new GitxError(`Claude CLI timed out (>${secs}s). Try reducing the number of changed files or use --no-comment.`, { exitCode: 1 });
    }
    throw new GitxError(`Claude CLI error: ${e.message ?? String(err)}`, { exitCode: 1 });
  }

  return stdout.trim().slice(0, maxOutputChars);
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

// ─── ClaudeCliAi ──────────────────────────────────────────────────────────────

export class ClaudeCliAi implements AiClient {
  /**
   * Returns true if the `claude` CLI binary is installed and accessible.
   */
  static async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("claude", ["--version"], { timeout: 8_000 });
      return true;
    } catch (err: unknown) {
      const e = err as { code?: string };
      return e.code !== "ENOENT";
    }
  }

  async analyzeTask(input: string): Promise<AiAnalyzeTaskResponse> {
    const system = `You are an expert software engineer. Analyze the development task and respond with ONLY valid JSON:
{"task":"<original task>","intent":"<refactor|bugfix|feature|chore|unknown>","summary":"<one sentence>","assumptions":["..."],"risks":["..."]}`;

    const text = await callClaudeCli(system, `Task: ${input}`);
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

    const fileList = ctx.repoFiles?.slice(0, 50).join("\n") ?? "(not provided)";
    const fileContentsSection =
      ctx.fileContents && Object.keys(ctx.fileContents).length > 0
        ? `\n\nRelevant file contents:\n${Object.entries(ctx.fileContents)
            .map(([p, c]) => `--- ${p} ---\n${c}`)
            .join("\n\n")}`
        : "";

    const system = `You are an expert software engineer creating a step-by-step implementation plan. Respond with ONLY valid JSON:
{"steps":[{"id":"step-1","title":"<short title>","description":"<detailed description>"}]}
Keep steps atomic and ordered.`;

    const userPrompt = `Task: ${ctx.task ?? ""}
Analysis: ${ctx.analysis?.summary ?? ""}
Repo files (top 50):
${fileList}${fileContentsSection}`;

    const text = await callClaudeCli(system, userPrompt);
    const parsed = parseJson<Partial<AiGeneratePlanResponse>>(text, { steps: [] });
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    return steps.length > 0
      ? { steps }
      : { steps: [{ id: "step-1", title: "Analyze & implement", description: ctx.task ?? "" }] };
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

    const system = `You are an expert software engineer. Generate unified diffs. Respond with ONLY valid JSON:
{"stepId":"<id>","diffs":[{"path":"<file path>","unifiedDiff":"<valid unified diff starting with --- a/path and +++ b/path>"}]}

Unified diff rules:
- Start with: --- a/<path>\\n+++ b/<path>
- Use @@ -<start>,<count> +<start>,<count> @@ headers
- ' ' = context, '-' = removed, '+' = added
- New files: --- /dev/null\\n+++ b/<path>
- Include 3 lines of context around changes`;

    const userPrompt = `Task: ${s.task ?? ""}
Step: ${stepId} — ${s.title ?? ""}
Description: ${s.description ?? ""}${fileContentsSection}`;

    const text = await callClaudeCli(system, userPrompt);
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

    const system = `You are a technical writer. Summarize code changes for a PR. Respond with ONLY valid JSON:
{"summary":"<2-3 sentence summary>","filesChanged":[{"path":"<file>","changeType":"<add|modify|delete>"}]}`;

    const text = await callClaudeCli(system, `Changes:\n${diffContent}`);
    const parsed = parseJson<Partial<AiSummarizeChangesResponse>>(text, { summary: "", filesChanged: [] });
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
      .map((co) => `[${co.author ?? "reviewer"}${co.path ? ` on ${co.path}:${co.line ?? ""}` : ""}]: ${co.body}`)
      .join("\n\n");

    const fileContentsSection =
      c.fileContents && Object.keys(c.fileContents).length > 0
        ? `\n\nCurrent file contents:\n${Object.entries(c.fileContents)
            .map(([p, content]) => `--- ${p} ---\n${content}`)
            .join("\n\n")}`
        : "";

    const system = `You are an expert code reviewer. Suggest fixes for PR review comments. Respond with ONLY valid JSON:
{"suggestedEdits":[{"path":"<file>","rationale":"<why>","unifiedDiff":"<valid unified diff>"}]}
Omit comments that need no code change.`;

    const userPrompt = `PR: ${c.prTitle ?? ""}
${c.prBody ?? ""}

Review Comments:\n${commentsText}${fileContentsSection}`;

    const text = await callClaudeCli(system, userPrompt);
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

    const diffSection = ctx.diff ? `\n\nDiff:\n${ctx.diff.slice(0, 8000)}` : "";
    const commentsSection =
      ctx.comments && ctx.comments.length > 0
        ? `\n\nExisting review comments:\n${ctx.comments
            .map((c) => `[${c.author}${c.path ? ` @ ${c.path}` : ""}]: ${c.body}`)
            .join("\n")}`
        : "";

    const system = `You are an expert code reviewer. Review the PR and respond with ONLY valid JSON:
{"summary":"<2-4 sentence assessment>","issues":[{"severity":"<critical|warning|suggestion>","description":"<issue>","file":"<optional>","line":null}],"positives":["<good thing>"],"verdict":"<approve|request_changes|comment>"}

Severity: critical=bugs/security, warning=quality/perf, suggestion=style/naming`;

    const userPrompt = `PR Title: ${ctx.prTitle ?? ""}
PR Description: ${ctx.prBody ?? ""}${diffSection}${commentsSection}`;

    const text = await callClaudeCli(system, userPrompt);
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

  async generatePrContent(commits: string[], diff: string): Promise<import("./types.js").AiPrContentResponse> {
    const system = `You are an expert software engineer writing pull request descriptions.
You are given a list of commits on the branch and the unified diff of all changes.

Produce a clear, informative PR title and description:

Rules:
- title: short, human-readable, present-tense. No conventional-commit prefix. Max 72 chars.
- body: 2-4 sentences describing WHAT changed and WHY. Plain English, no bullet points.

Respond with ONLY valid JSON (no markdown fences):
{"title":"<PR title>","body":"<PR description>"}`;

    const commitList = commits.slice(0, 20).join("\n");
    const userPrompt = `Commits on this branch:\n${commitList}\n\nDiff:\n${diff.slice(0, 16000)}`;
    const text = await callClaudeCli(system, userPrompt);
    const parsed = parseJson<Partial<import("./types.js").AiPrContentResponse>>(text, {});
    return {
      title: parsed.title?.trim() ?? "Update branch",
      body: parsed.body?.trim() ?? "",
    };
  }

<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> origin/main
  async resolveConflict(filePath: string, conflictContent: string): Promise<import("./types.js").AiConflictResolutionResponse> {
    const system = `You are an expert software engineer resolving git merge conflicts.

The file contains standard git conflict markers:
  <<<<<<< HEAD  — changes on the current branch
  =======       — separator
  >>>>>>> theirs — incoming changes

Your task:
1. Understand BOTH sides of every conflict.
2. Produce a single correct version preserving the intent of BOTH changes where possible.
3. If the sides are genuinely contradictory, set confidence to "low".

Rules:
- Remove ALL conflict markers from the output.
- Do NOT add explanatory comments.
- Keep all non-conflicting code exactly as-is.
- Output must be syntactically valid.

Respond with ONLY valid JSON (no markdown fences):
{"resolved":"<full resolved file content>","confidence":"high|low","explanation":"<one sentence>"}`;

    const userPrompt = `File: ${filePath}\n\n${conflictContent.slice(0, 20000)}`;
    const text = await callClaudeCli(system, userPrompt);
    const parsed = parseJson<Partial<import("./types.js").AiConflictResolutionResponse>>(text, {});
    return {
      resolved: parsed.resolved ?? conflictContent,
      confidence: parsed.confidence === "low" ? "low" : "high",
      explanation: parsed.explanation?.trim() ?? "Conflict resolved.",
    };
  }

<<<<<<< HEAD
=======
=======
>>>>>>> origin/main
>>>>>>> origin/main
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

    const text = await callClaudeCli(system, `Diff:\n${diff.slice(0, 20000)}`);
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
    const text = await callClaudeCli(
      buildSeniorReviewSystem(),
      buildSeniorReviewPrompt(context),
      { timeoutMs: 300_000, maxOutputChars: 60_000 }  // 5 min timeout, large output for full review JSON
    );
    return parseSeniorReview(text);
  }

  async generateFix(
    context: Parameters<import("./types.js").AiClient["generateFix"]>[0]
  ): Promise<import("./types.js").AiFixResponse> {
    const { buildFixSystem, buildFixPrompt, parseFixResponse } = await import("./reviewHelpers.js");
    const text = await callClaudeCli(
      buildFixSystem(),
      buildFixPrompt(context),
      { timeoutMs: 120_000, maxOutputChars: 8_000 }
    );
    return parseFixResponse(text, context.filePath, context.line);
  }
}
