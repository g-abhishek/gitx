/**
 * Shared helpers for the senior-developer PR review.
 *
 * buildSeniorReviewSystem()  — the AI system prompt
 * buildSeniorReviewPrompt()  — formats the user-facing context block
 * parseSeniorReview()        — safely parses the AI JSON response
 */

import type { AiDetailedReviewResponse } from "./types.js";

// ─── System prompt ────────────────────────────────────────────────────────────

export function buildSeniorReviewSystem(): string {
  return `You are a principal software engineer and tech lead doing a thorough pull request review.
You have full access to the changed files, the diff, and supporting context files from the codebase.

Your review MUST cover every one of these dimensions:
  1. Correctness   — logic errors, off-by-one, wrong conditions, silent failures
  2. Security      — injection, auth bypass, secret leakage, unvalidated input
  3. Robustness    — missing error handling, null/undefined guard, edge cases
  4. Performance   — unnecessary loops, N+1 queries, missing caching
  5. Breaking changes — does this break existing API contracts, interfaces, or callers?
  6. Best practices — naming, DRY, SOLID, idiomatic language usage
  7. Test coverage — are critical paths tested? are tests meaningful?
  8. Documentation — are public APIs documented? are complex sections explained?

For EVERY issue you find that maps to a specific line, add an inline comment.
Use the full changed file content (not just the diff) to determine exact line numbers.
Count lines starting at 1. Only reference lines that exist in the NEW version of the file.

Verdict rules:
  - "approve"          → no critical or warning issues
  - "request_changes"  → one or more critical/warning issues found
  - "comment"          → only suggestions / minor observations

Respond with ONLY valid JSON (no markdown fences, no prose outside JSON):
{
  "summary": "<3-5 sentence executive summary>",
  "verdict": "approve|request_changes|comment",
  "issues": [
    { "severity": "critical|warning|suggestion", "description": "<issue>", "file": "<path or null>", "line": <number or null> }
  ],
  "inlineComments": [
    { "path": "<relative file path>", "line": <line number>, "body": "<markdown comment>", "severity": "critical|warning|suggestion", "suggestion": "<replacement code or null>" }
  ],
  "positives": ["<good thing>"],
  "testingNotes": "<how to manually test>",
  "checklist": [
    { "area": "<Correctness|Security|Robustness|Performance|Breaking changes|Best practices|Tests|Documentation>", "status": "pass|warn|fail", "note": "<one sentence>" }
  ]
}`;
}

// ─── User prompt builder ──────────────────────────────────────────────────────

export function buildSeniorReviewPrompt(
  context: {
    prTitle: string;
    prBody: string;
    author: string;
    headBranch: string;
    baseBranch: string;
    diff: string;
    changedFiles: Record<string, string>;
    contextFiles: Record<string, string>;
    repoFileList: string[];
    existingComments: Array<{ author: string; body: string; path?: string; line?: number }>;
  }
): string {
  const parts: string[] = [];

  parts.push(`## PR: ${context.prTitle}`);
  parts.push(`Author: ${context.author}   |   ${context.headBranch} → ${context.baseBranch}`);
  if (context.prBody.trim()) {
    parts.push(`\n### Description\n${context.prBody.slice(0, 2000)}`);
  }

  // Changed files — full content (most important context)
  const changedEntries = Object.entries(context.changedFiles);
  if (changedEntries.length > 0) {
    parts.push(`\n### Changed files (full content after PR changes)`);
    for (const [path, content] of changedEntries) {
      // Add line numbers so the AI can reference them accurately
      const numbered = content
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`)
        .join("\n");
      parts.push(`\n#### ${path}\n\`\`\`\n${numbered.slice(0, 6000)}\n\`\`\``);
    }
  }

  // Diff (for visibility into what actually changed)
  if (context.diff.trim()) {
    parts.push(`\n### Unified diff (may be truncated)\n\`\`\`diff\n${context.diff.slice(0, 12000)}\n\`\`\``);
  }

  // Context / supporting files (imports, shared types, etc.)
  const ctxEntries = Object.entries(context.contextFiles);
  if (ctxEntries.length > 0) {
    parts.push(`\n### Supporting context files (unchanged — included for reference)`);
    for (const [path, content] of ctxEntries) {
      parts.push(`\n#### ${path}\n\`\`\`\n${content.slice(0, 2500)}\n\`\`\``);
    }
  }

  // Existing PR comments
  if (context.existingComments.length > 0) {
    parts.push(`\n### Existing review comments`);
    for (const c of context.existingComments.slice(0, 10)) {
      const loc = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : "";
      parts.push(`- **${c.author}**${loc}: ${c.body.slice(0, 200)}`);
    }
  }

  // Repo file tree (structural awareness)
  if (context.repoFileList.length > 0) {
    parts.push(`\n### Repository file tree (top 80 files)\n${context.repoFileList.slice(0, 80).join("\n")}`);
  }

  return parts.join("\n");
}

// ─── Response parser ──────────────────────────────────────────────────────────

export function parseSeniorReview(text: string): AiDetailedReviewResponse {
  let parsed: Partial<AiDetailedReviewResponse> = {};
  try {
    // Extract JSON from possible markdown fences
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced?.[1]?.trim() ?? text.trim();
    const start = raw.search(/\{/);
    const end = raw.lastIndexOf("}");
    const jsonStr = start !== -1 && end > start ? raw.slice(start, end + 1) : raw;
    parsed = JSON.parse(jsonStr) as Partial<AiDetailedReviewResponse>;
  } catch {
    // Fallback — return safe defaults
    return {
      summary: "AI review could not be parsed. Please inspect the diff manually.",
      verdict: "comment",
      issues: [],
      inlineComments: [],
      positives: [],
      testingNotes: "Test the changed functionality manually.",
      checklist: [],
    };
  }

  return {
    summary: parsed.summary ?? "Review generated.",
    verdict: (["approve", "request_changes", "comment"].includes(parsed.verdict ?? ""))
      ? (parsed.verdict as AiDetailedReviewResponse["verdict"])
      : "comment",
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    inlineComments: Array.isArray(parsed.inlineComments)
      ? parsed.inlineComments.filter((c) => c.path && c.line > 0)
      : [],
    positives: Array.isArray(parsed.positives) ? parsed.positives : [],
    testingNotes: parsed.testingNotes ?? "",
    checklist: Array.isArray(parsed.checklist) ? parsed.checklist : [],
  };
}
