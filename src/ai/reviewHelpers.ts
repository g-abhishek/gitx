/**
 * Shared helpers for the senior-developer PR review.
 *
 * buildSeniorReviewSystem()  — the AI system prompt
 * buildSeniorReviewPrompt()  — formats the user-facing context block
 * parseSeniorReview()        — safely parses the AI JSON response
 */

import type { AiAskContext, AiAskResponse, AiDetailedReviewResponse, AiFixResponse } from "./types.js";

// ─── System prompt ────────────────────────────────────────────────────────────

export function buildSeniorReviewSystem(): string {
  return `You are a principal software engineer and tech lead doing a thorough pull request review.
You have access to the CHANGED SECTIONS of each file (extracted around the exact lines that changed),
plus supporting context files and the full unified diff.

Your review MUST cover every one of these dimensions:
  1. Correctness   — logic errors, off-by-one, wrong conditions, silent failures
  2. Security      — injection, auth bypass, secret leakage, unvalidated input
  3. Robustness    — missing error handling, null/undefined guard, edge cases
  4. Performance   — unnecessary loops, N+1 queries, missing caching
  5. Breaking changes — does this break existing API contracts, interfaces, or callers?
  6. Best practices — naming, DRY, SOLID, idiomatic language usage
  7. Test coverage — are critical paths tested? are tests meaningful?
  8. Documentation — are public APIs documented? are complex sections explained?

For EVERY issue that maps to a specific line, add an inline comment.
Line numbers shown in the excerpts are the REAL line numbers in the new file — use them exactly.
Only reference lines that appear in the excerpts you were given.

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

// ─── Diff parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a unified diff and return the NEW-file line ranges that were touched,
 * grouped by file path.
 *
 * A diff hunk header looks like:  @@ -10,7 +12,8 @@
 *   +12,8  →  new file starts at line 12, hunk spans 8 lines
 */
function parseHunkRanges(diff: string): Map<string, Array<{ start: number; end: number }>> {
  const result = new Map<string, Array<{ start: number; end: number }>>();
  let currentFile = "";

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch?.[1] && fileMatch[1] !== "/dev/null") {
      currentFile = fileMatch[1].trim();
      if (!result.has(currentFile)) result.set(currentFile, []);
      continue;
    }

    // @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const start = parseInt(hunkMatch[1]!, 10);
      const count = parseInt(hunkMatch[2] ?? "1", 10);
      result.get(currentFile)!.push({ start, end: start + Math.max(count - 1, 0) });
    }
  }

  return result;
}

/**
 * Scan BACKWARD from `fromLine` (1-based) to find where the containing
 * function / class / method starts.
 *
 * Recognises common declaration patterns for TypeScript, JavaScript, Python,
 * Go, Rust, Java, and C#.  Falls back to `fromLine - fallback` if nothing
 * is found within `maxScan` lines.
 */
function findContainerStart(
  lines: string[],
  fromLine: number,
  maxScan = 80,
  fallback = 30
): number {
  // fromLine is 1-based; lines[] is 0-based
  const startIdx = Math.min(lines.length - 1, Math.max(0, fromLine - 2));

  for (let i = startIdx; i >= Math.max(0, startIdx - maxScan); i--) {
    const line = lines[i] ?? "";
    if (
      // TS/JS: export [default] [abstract] [async] function foo(
      /^\s*(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?function[\s*]/.test(line) ||
      // TS/JS: export [abstract] class Foo
      /^\s*(export\s+)?(abstract\s+)?class\s+\w/.test(line) ||
      // TS/JS class methods: [public|private|protected|static|override|async] methodName(
      /^\s*(public|private|protected|static|override|async)(\s+(public|private|protected|static|override|async))*\s+\w+\s*[(<]/.test(line) ||
      // TS/JS arrow function assigned to const/let/var
      /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(line) ||
      // TS/JS shorthand method (no keyword): methodName(args) {
      /^\s*\w+\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/.test(line) ||
      // Python: def foo(
      /^\s*def\s+\w+\s*\(/.test(line) ||
      // Go: func (recv) Foo(
      /^\s*func\s+/.test(line) ||
      // Rust: fn foo(
      /^\s*(pub\s+)?(async\s+)?fn\s+\w+/.test(line) ||
      // Java/C#: returnType methodName(
      /^\s*(public|private|protected|internal|static|virtual|override)\s+\S+\s+\w+\s*\(/.test(line)
    ) {
      return i + 1; // convert back to 1-based
    }
  }

  // Nothing found — fall back to a fixed number of lines above
  return Math.max(1, fromLine - fallback);
}

/**
 * Extract the sections of a file that were changed, always starting each
 * window at the nearest enclosing function/class boundary (or 30 lines up,
 * whichever is closer).
 *
 * Overlapping windows are merged so the same lines aren't shown twice.
 * The first HEADER_LINES of the file are always prepended (imports, class
 * declarations) so the AI understands module structure.
 *
 * Returns a line-numbered string ready to paste into the prompt.
 */
function extractChangedSections(
  fileContent: string,
  hunks: Array<{ start: number; end: number }>,
  contextLinesBelow = 20   // lines below the hunk (above uses function-boundary scan)
): string {
  const lines = fileContent.split("\n");
  const total = lines.length;

  // Always include file header (imports / module preamble) for structural context
  const HEADER_LINES = 20;

  // Build windows: above = scan to function start, below = fixed context
  const windows: Array<{ start: number; end: number }> = [];
  for (const hunk of hunks) {
    const windowStart = findContainerStart(lines, hunk.start);
    windows.push({
      start: windowStart,
      end: Math.min(total, hunk.end + contextLinesBelow),
    });
  }
  // Sort then merge
  windows.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    if (merged.length > 0 && w.start <= merged[merged.length - 1]!.end + 1) {
      merged[merged.length - 1]!.end = Math.max(merged[merged.length - 1]!.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }

  const formatRange = (start: number, end: number): string =>
    lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(5, " ")} | ${l}`)
      .join("\n");

  const sections: string[] = [];

  // File header (always included, unless the first window already covers it)
  const firstWindowStart = merged[0]?.start ?? 1;
  if (firstWindowStart > HEADER_LINES + 1) {
    sections.push(formatRange(1, Math.min(HEADER_LINES, total)));
    sections.push("      … (lines omitted) …");
  }

  for (let i = 0; i < merged.length; i++) {
    const { start, end } = merged[i]!;
    if (i > 0 && start > (merged[i - 1]!.end + 1)) {
      sections.push("      … (lines omitted) …");
    }
    sections.push(formatRange(start, end));
  }

  return sections.join("\n");
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
    parts.push(`\n### Description\n${context.prBody.slice(0, 1000)}`);
  }

  // ── Parse which lines actually changed per file ───────────────────────────
  const hunkRanges = parseHunkRanges(context.diff);

  // ── Changed file sections — only the relevant areas + function context ──────
  // Hard per-file cap: if a single function is genuinely 500+ lines we still
  // need to stop somewhere, but we ALWAYS stop on a complete line boundary so
  // the AI never sees half a statement.
  // The per-file cap is generous (300 lines) to handle large but realistic functions.
  const PER_FILE_LINE_CAP = 300;
  const DIFF_BUDGET       = 5_000;
  const CTX_FILE_MAX      = 1_500;

  const changedEntries = Object.entries(context.changedFiles);
  if (changedEntries.length > 0) {
    parts.push(`\n### Changed sections (line numbers are exact positions in the new file)`);

    for (const [path, content] of changedEntries) {
      const hunks = hunkRanges.get(path) ?? [];

      let excerpt: string;
      if (hunks.length === 0) {
        // No hunk data (binary / rename-only) — show first 60 lines as fallback
        const lines = content.split("\n");
        excerpt = lines
          .slice(0, 60)
          .map((l, i) => `${String(i + 1).padStart(5, " ")} | ${l}`)
          .join("\n");
        if (lines.length > 60) excerpt += "\n      … (file continues — only first 60 lines shown as fallback)";
      } else {
        excerpt = extractChangedSections(content, hunks);
      }

      // Cap at PER_FILE_LINE_CAP complete lines — never mid-line
      const excerptLines = excerpt.split("\n");
      let finalExcerpt: string;
      if (excerptLines.length > PER_FILE_LINE_CAP) {
        finalExcerpt =
          excerptLines.slice(0, PER_FILE_LINE_CAP).join("\n") +
          `\n      … (${excerptLines.length - PER_FILE_LINE_CAP} more lines not shown` +
          ` — this function is unusually large; review the diff for remaining changes)`;
      } else {
        finalExcerpt = excerpt;
      }

      const hunkDesc = hunks.length > 0
        ? ` (${hunks.length} change hunk${hunks.length > 1 ? "s" : ""})`
        : "";
      parts.push(`\n#### ${path}${hunkDesc}\n\`\`\`\n${finalExcerpt}\n\`\`\``);
    }
  }

  // ── Diff (compact view of what changed, used for overall change understanding)
  if (context.diff.trim()) {
    const diffSlice = context.diff.slice(0, DIFF_BUDGET);
    const diffTrunc = diffSlice.length < context.diff.length;
    parts.push(
      `\n### Unified diff${diffTrunc ? " (truncated)" : ""}\n\`\`\`diff\n${diffSlice}\n\`\`\``
    );
  }

  // ── Supporting context files (unchanged files the changes depend on) ──────
  const ctxEntries = Object.entries(context.contextFiles);
  if (ctxEntries.length > 0) {
    parts.push(`\n### Supporting context files (unchanged — imported by changed files)`);
    for (const [path, content] of ctxEntries) {
      parts.push(`\n#### ${path}\n\`\`\`\n${content.slice(0, CTX_FILE_MAX)}\n\`\`\``);
    }
  }

  // ── Existing PR comments ──────────────────────────────────────────────────
  if (context.existingComments.length > 0) {
    parts.push(`\n### Existing review comments`);
    for (const c of context.existingComments.slice(0, 6)) {
      const loc = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : "";
      parts.push(`- **${c.author}**${loc}: ${c.body.slice(0, 150)}`);
    }
  }

  // ── Repo file tree (structural awareness) ────────────────────────────────
  if (context.repoFileList.length > 0) {
    parts.push(`\n### Repository file tree (top 60 files)\n${context.repoFileList.slice(0, 60).join("\n")}`);
  }

  return parts.join("\n");
}

// ─── Response parser ──────────────────────────────────────────────────────────

export function parseSeniorReview(text: string): AiDetailedReviewResponse {
  let parsed: Partial<AiDetailedReviewResponse> = {};
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced?.[1]?.trim() ?? text.trim();
    const start = raw.search(/\{/);
    const end = raw.lastIndexOf("}");
    const jsonStr = start !== -1 && end > start ? raw.slice(start, end + 1) : raw;
    parsed = JSON.parse(jsonStr) as Partial<AiDetailedReviewResponse>;
  } catch {
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

// ─── Fix generation helpers ───────────────────────────────────────────────────

/**
 * System prompt for the AI fix generator.
 * Instructs the model to produce a minimal, targeted line-range replacement.
 */
export function buildFixSystem(): string {
  return `You are a senior developer addressing a pull request review comment.
Your job is to generate the MINIMAL code change that addresses the reviewer's concern.

Rules:
- Change as few lines as possible — do not refactor surrounding code
- Preserve the existing indentation style exactly
- If the comment is a question or discussion (no code change needed), set isDiscussion: true
- If you are unsure of the correct fix, set confidence: "low"
- startLine and endLine are 1-based, inclusive line numbers in the CURRENT file

Respond with ONLY valid JSON (no markdown fences, no prose outside JSON):
{
  "file": "<relative file path>",
  "startLine": <1-based line where replacement starts>,
  "endLine": <1-based line where replacement ends, inclusive>,
  "replacement": "<new code lines, newline-separated, preserving indentation>",
  "explanation": "<one sentence: what you changed and why>",
  "confidence": "high|low",
  "resolves": true|false,
  "isDiscussion": true|false
}`;
}

/**
 * Build the user prompt for a single fix request.
 * Includes the comment, file content with line numbers, and the relevant diff.
 */
export function buildFixPrompt(ctx: {
  comment: string;
  commentAuthor: string;
  filePath: string;
  line: number;
  fileContent: string;
  fileDiff: string;
}): string {
  const lines = ctx.fileContent.split("\n");

  // Show a window of ±30 lines around the commented line (with real line numbers)
  const windowStart = Math.max(1, ctx.line - 30);
  const windowEnd   = Math.min(lines.length, ctx.line + 30);
  const excerpt = lines
    .slice(windowStart - 1, windowEnd)
    .map((l, i) => `${String(windowStart + i).padStart(4, " ")} | ${l}`)
    .join("\n");

  const diffSection = ctx.fileDiff.length > 3000
    ? ctx.fileDiff.slice(0, 3000) + "\n... (diff truncated)"
    : ctx.fileDiff;

  return `## Review Comment
Author: ${ctx.commentAuthor}
File: ${ctx.filePath}  ·  Line: ${ctx.line}

> ${ctx.comment.replace(/\n/g, "\n> ")}

## File Context (lines ${windowStart}–${windowEnd} of ${lines.length})
\`\`\`
${excerpt}
\`\`\`

## Diff for this file
\`\`\`diff
${diffSection}
\`\`\`

Generate the fix JSON now.`;
}

/**
 * Safely parse the AI response for a fix request.
 * Returns a safe fallback (isDiscussion + low confidence) on parse failure.
 */
export function parseFixResponse(text: string, filePath: string, line: number): AiFixResponse {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no JSON found");
    const parsed = JSON.parse(jsonMatch[0]) as Partial<AiFixResponse>;

    if (parsed.isDiscussion) {
      return {
        file: parsed.file ?? filePath,
        startLine: line,
        endLine: line,
        replacement: "",
        explanation: parsed.explanation ?? "This comment is a discussion — no code change needed.",
        confidence: "low",
        resolves: parsed.resolves ?? false,
        isDiscussion: true,
      };
    }

    // Validate required fields; fall back to low confidence if anything is off
    const hasReplacement = typeof parsed.replacement === "string";
    const hasLines = typeof parsed.startLine === "number" && typeof parsed.endLine === "number";
    if (!hasReplacement || !hasLines) {
      throw new Error("missing required fields");
    }

    return {
      file: parsed.file ?? filePath,
      startLine: parsed.startLine!,
      endLine: parsed.endLine!,
      replacement: parsed.replacement!,
      explanation: parsed.explanation ?? "AI-generated fix.",
      confidence: parsed.confidence === "high" ? "high" : "low",
      resolves: parsed.resolves ?? false,
      isDiscussion: false,
    };
  } catch {
    return {
      file: filePath,
      startLine: line,
      endLine: line,
      replacement: "",
      explanation: "AI could not generate a fix for this comment.",
      confidence: "low",
      resolves: false,
      isDiscussion: true, // treat parse failure as discussion → no code change
    };
  }
}

// ─── Ask command helpers ───────────────────────────────────────────────────────

/** Command reference embedded into the ask system prompt. */
const GITX_COMMAND_REFERENCE = `
## gitx Command Reference

| Command | Description |
|---------|-------------|
| gitx init / gitx config setup | Interactive setup wizard — configure git & AI providers |
| gitx config show | Display current configuration (secrets redacted) |
| gitx config set <key> [value] | Set a single config value (provider, token, model, etc.) |
| gitx commit [-m msg] [--push] [--dry-run] | AI-generate commit message → commit (optionally push) |
| gitx push [-b branch] [--dry-run] | Stage → AI-commit → push in one step |
| gitx sync [--base branch] [--strategy merge|rebase] [--continue] [--abort] | Sync current branch with base; AI resolves conflicts |
| gitx implement "<task>" [--mode plan|guided|semi-auto|auto] [--dry-run] | AI-plan and implement a task end-to-end |
| gitx pr list [--state open|closed|all] | List pull requests |
| gitx pr create [--title T] [--body B] [--draft] [--dry-run] | AI-generate PR title/body → open PR |
| gitx pr review <number> [--no-comment] [--address] [--no-push] | Senior-dev AI review with inline comments |
| gitx pr fix-comments <number> [--dry-run] [--no-push] | AI-fix review comments and push |
| gitx pr merge <number> [--strategy squash|merge|rebase] [--delete-branch] | Merge a PR |
| gitx pr close <number> [-f] | Close a PR |
| gitx ask "<question>" [--pr] | Ask a question about the repo using AI + live git context |

## Supported Providers
- Git hosts: GitHub, GitLab, Azure DevOps
- AI backends: Anthropic Claude (API), OpenAI, Local Claude CLI

## Environment Variables
- ANTHROPIC_API_KEY — Anthropic API key (auto-selects Claude as AI provider)
- OPENAI_API_KEY    — OpenAI API key
- GITX_AI_MODEL    — Override the AI model name
- GITX_DEBUG=1     — Print full stack traces on errors
`.trim();

/**
 * Builds the system prompt for `gitx ask`.
 * Includes the full command reference and setup guidance so the AI can answer
 * both "how do I…" questions and "is X configured?" diagnostics.
 */
export function buildAskSystem(): string {
  return `You are gitx-assistant, a smart support assistant embedded in the gitx CLI.
You help users with three types of questions:

1. SETUP / DIAGNOSTIC — "is my AI provider set up?", "why isn't gitx working?", "what provider am I using?"
   → Use the GITX SETUP STATUS section in the context. Give a clear yes/no diagnostic and actionable fix steps.

2. REPO STATE — "what did I last commit?", "do I have unstaged changes?", "show me open PRs"
   → Use the LIVE REPO CONTEXT section in the context.

3. HOW-TO — "how do I sync with main?", "how do I undo a commit?", "how do I create a PR?"
   → Use the GITX COMMAND REFERENCE below. Show the exact command.

${GITX_COMMAND_REFERENCE}

## Setup Fix Guide (use when AI or provider is not configured)
- No AI provider → Run: gitx config setup  (or set ANTHROPIC_API_KEY / OPENAI_API_KEY env var)
- AI provider configured in config but not working → Run: gitx config show  to inspect; re-run gitx config set <provider>
- No git provider token → Run: gitx config set github  (or gitlab / azure)
- Not inside a git repo → cd into your project folder first

Rules:
- Answer concisely and accurately. Get to the point immediately.
- For setup/diagnostic questions: state clearly whether it IS or IS NOT configured, then explain WHY and how to fix it.
- Never fabricate details — only use what is in the provided context.
- Format your answer in plain text. Use a code block only for commands or file paths.
- When suggesting commands, put them in suggestedCommands so they render highlighted.

Respond with ONLY valid JSON (no markdown fences):
{"answer":"<answer text>","suggestedCommands":["<cmd1>","<cmd2>"]}

The suggestedCommands array may be empty [] if no command applies.`;
}

/**
 * Builds the user-turn prompt for `gitx ask`, injecting live repo context
 * and the full gitx setup status so the AI can answer diagnostic questions accurately.
 */
export function buildAskPrompt(question: string, ctx: AiAskContext): string {
  const lines: string[] = [];

  // ── Section 1: gitx setup status ──────────────────────────────────────────
  lines.push(`## gitx Setup Status`);

  // AI provider
  const ai = ctx.aiSetup;
  lines.push(`- AI provider: ${ai.provider}`);
  lines.push(`- AI configured: ${ai.isConfigured ? "YES" : "NO — not configured"}`);
  if (ai.model) lines.push(`- AI model: ${ai.model}`);
  lines.push(`- AI key source: ${ai.keySource}`);

  // Git providers
  if (ctx.gitProviders.length > 0) {
    lines.push(`- Git providers configured:`);
    ctx.gitProviders.forEach((p) => {
      const tokenStatus = p.hasToken ? "token ✓" : "token MISSING";
      lines.push(`    ${p.name}: ${tokenStatus}`);
    });
  } else {
    lines.push(`- Git providers configured: none`);
  }

  if (ctx.defaultBranch) {
    lines.push(`- Default base branch: ${ctx.defaultBranch}`);
  }

  // ── Section 2: live repo context ──────────────────────────────────────────
  lines.push(``);
  lines.push(`## Live Repo Context`);
  lines.push(`- Inside git repo: ${ctx.isInsideGitRepo ? "YES" : "NO"}`);

  if (ctx.isInsideGitRepo) {
    lines.push(`- Current branch: ${ctx.currentBranch}`);

    if (ctx.recentCommits.length > 0) {
      lines.push(`- Recent commits (newest first):`);
      ctx.recentCommits.forEach((c) => lines.push(`    ${c}`));
    } else {
      lines.push(`- Recent commits: (none yet)`);
    }

    if (ctx.gitStatus.trim()) {
      lines.push(`- Working tree status:\n${ctx.gitStatus}`);
    } else {
      lines.push(`- Working tree status: clean`);
    }

    if (ctx.stashes && ctx.stashes.length > 0) {
      lines.push(`- Stashes:`);
      ctx.stashes.forEach((s) => lines.push(`    ${s}`));
    }

    if (ctx.openPRs && ctx.openPRs.length > 0) {
      lines.push(`- Open PRs:`);
      ctx.openPRs.forEach((pr) =>
        lines.push(`    #${pr.number} [${pr.state}] "${pr.title}" (branch: ${pr.branch})`)
      );
    }
  }

  // ── Section 3: question ───────────────────────────────────────────────────
  lines.push(``);
  lines.push(`## Question`);
  lines.push(question);

  return lines.join("\n");
}

/**
 * Safely parses the AI JSON response for `gitx ask`.
 * Falls back to using the raw text as the answer if JSON parsing fails.
 */
export function parseAskResponse(raw: string): AiAskResponse {
  try {
    const parsed = JSON.parse(raw) as Partial<AiAskResponse>;
    return {
      answer: parsed.answer?.trim() ?? raw.trim(),
      suggestedCommands: Array.isArray(parsed.suggestedCommands)
        ? parsed.suggestedCommands.filter((c): c is string => typeof c === "string")
        : [],
    };
  } catch {
    // If the AI returned plain text instead of JSON, use it directly
    return { answer: raw.trim(), suggestedCommands: [] };
  }
}
