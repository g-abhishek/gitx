/**
 * PR Address Workflow
 *
 * Reads unresolved review comments on a PR, generates AI fixes for each one,
 * applies them to local files, and optionally commits, pushes, and replies
 * to each thread marking it as addressed.
 *
 * Used by:
 *   - `gitx pr review <n>`  — offered interactively after the review output
 *   - `gitx sync`           — offered when unresolved comments are detected
 */

import ora from "ora";
import { select, confirm } from "@inquirer/prompts";
import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Gitx } from "../core/gitx.js";
import type { PullRequestComment } from "../providers/base.js";
import type { AiFixResponse } from "../ai/types.js";
import { createProvider } from "../providers/factory.js";
import { readRepoFile } from "../utils/gitOps.js";
import { logger } from "../logger/logger.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, { cwd });
    return { stdout: result.stdout.trim(), stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout?.trim() ?? "",
      stderr: (e.stderr ?? e.message ?? String(err)).trim(),
    };
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AddressedComment {
  comment: PullRequestComment;
  fix: AiFixResponse;
  applied: boolean;
  skipped: boolean;
  /** Reason for skipping (user choice, low-confidence rejection, patch error) */
  skipReason?: string;
}

export interface AddressWorkflowResult {
  addressed: AddressedComment[];
  filesChanged: string[];
  pushed: boolean;
  commitSha?: string;
  repliedCount: number;
}

// ─── Patch application ────────────────────────────────────────────────────────

/**
 * Apply a line-range replacement to a file on disk.
 * Replaces lines startLine–endLine (1-based, inclusive) with `replacement`.
 * Returns the new file content, or throws if the line range is invalid.
 */
function applyLineReplacement(
  originalContent: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  const lines = originalContent.split("\n");
  const total = lines.length;

  if (startLine < 1 || endLine < startLine || endLine > total + 1) {
    throw new Error(
      `Line range ${startLine}–${endLine} is out of bounds (file has ${total} lines)`
    );
  }

  const before = lines.slice(0, startLine - 1);
  const after  = lines.slice(endLine);           // everything after endLine
  const newLines = replacement === "" ? [] : replacement.split("\n");

  return [...before, ...newLines, ...after].join("\n");
}

/**
 * Render a human-readable before/after diff for the terminal.
 */
function renderLineDiff(
  filePath: string,
  content: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  const lines = content.split("\n");
  const removed = lines.slice(startLine - 1, endLine);
  const added   = replacement === "" ? [] : replacement.split("\n");

  const out: string[] = [`\n   📄 ${filePath}  (lines ${startLine}–${endLine})\n`];
  for (const l of removed) out.push(`   \x1b[31m- ${l}\x1b[0m`);
  for (const l of added)   out.push(`   \x1b[32m+ ${l}\x1b[0m`);
  return out.join("\n");
}

// ─── Comment filtering ────────────────────────────────────────────────────────

/** Filter to comments that are on a specific file line (inline review comments). */
function isInlineComment(c: PullRequestComment): boolean {
  return !!c.path && typeof c.line === "number" && c.line > 0;
}

/** Skip bot-generated comments (gitx review replies, etc.) */
function isHumanComment(c: PullRequestComment): boolean {
  const botPrefixes = ["🤖", "✅ Addressed", "📍", "*(in reply to"];
  return !botPrefixes.some((p) => c.body.trimStart().startsWith(p));
}

// ─── Main workflow ────────────────────────────────────────────────────────────

export interface AddressWorkflowOptions {
  /**
   * "interactive" (default) — show each fix and ask to apply.
   * "auto"        — apply all high-confidence fixes silently, skip low-confidence.
   * "no-push"     — same as interactive but never commits or pushes.
   */
  mode?: "interactive" | "auto" | "no-push";
}

export async function runAddressWorkflow(
  gitx: Gitx,
  prNumber: number,
  opts: AddressWorkflowOptions = {}
): Promise<AddressWorkflowResult> {
  const mode = opts.mode ?? "interactive";
  const cwd  = gitx.cwd;
  const ctx  = await gitx.getRepoContext();
  const provider = createProvider(ctx);

  // ── 1. Fetch comments ──────────────────────────────────────────────────────
  const fetchSpinner = ora("Fetching PR review comments…").start();
  const allComments = await provider.getPRComments(ctx.repoSlug, prNumber);
  const comments = allComments.filter(isInlineComment).filter(isHumanComment);
  fetchSpinner.succeed(
    `Found ${comments.length} inline review comment(s) to address` +
    (allComments.length - comments.length > 0
      ? ` (${allComments.length - comments.length} general/bot comments skipped)`
      : "")
  );

  if (comments.length === 0) {
    logger.info("ℹ️  No inline review comments to address.");
    return { addressed: [], filesChanged: [], pushed: false, repliedCount: 0 };
  }

  // ── 2. Load file contents + diff ──────────────────────────────────────────
  const loadSpinner = ora("Loading file context…").start();
  const diff = await provider.getPRDiff(ctx.repoSlug, prNumber).catch(() => "");

  // Build per-file diff sections
  const fileDiffs = new Map<string, string>();
  let currentFile = "";
  const diffLines: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)/);
    if (m?.[1]) {
      if (currentFile && diffLines.length) fileDiffs.set(currentFile, diffLines.join("\n"));
      currentFile = m[1].trim();
      diffLines.length = 0;
    }
    diffLines.push(line);
  }
  if (currentFile && diffLines.length) fileDiffs.set(currentFile, diffLines.join("\n"));

  // Build per-file content map (deduplicated — one read per file)
  const fileContents = new Map<string, string>();
  for (const c of comments) {
    if (!c.path || fileContents.has(c.path)) continue;
    const content = await readRepoFile(c.path, cwd);
    if (content) fileContents.set(c.path, content);
  }
  loadSpinner.succeed(`Loaded context for ${fileContents.size} file(s).`);

  // ── 3. Generate + apply fixes ─────────────────────────────────────────────
  const addressed: AddressedComment[] = [];
  const modifiedFiles = new Map<string, string>(); // tracks in-memory modified content

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i]!;
    const filePath = comment.path!;
    const line     = comment.line!;

    logger.info(
      `\n${"─".repeat(60)}\n` +
      `📄 [${i + 1}/${comments.length}]  ${filePath} · Line ${line}\n` +
      `💬 ${comment.author}: ${comment.body.slice(0, 200)}${comment.body.length > 200 ? "…" : ""}\n`
    );

    // Use in-memory content if file was already modified in this session
    const currentContent = modifiedFiles.get(filePath) ?? fileContents.get(filePath) ?? "";
    if (!currentContent) {
      logger.warn(`   ⚠️  Could not load file content — skipping.`);
      addressed.push({ comment, fix: makeFallbackFix(filePath, line), applied: false, skipped: true, skipReason: "file not found" });
      continue;
    }

    // Generate fix
    const fixSpinner = ora("   🤖 AI generating fix…").start();
    let fix: AiFixResponse;
    try {
      fix = await gitx.ai.generateFix({
        comment: comment.body,
        commentAuthor: comment.author,
        filePath,
        line,
        fileContent: currentContent,
        fileDiff: fileDiffs.get(filePath) ?? "",
      });
      fixSpinner.succeed("   AI fix generated.");
    } catch (err) {
      fixSpinner.fail(`   AI fix failed: ${(err as Error).message}`);
      addressed.push({ comment, fix: makeFallbackFix(filePath, line), applied: false, skipped: true, skipReason: "AI error" });
      continue;
    }

    // Discussion — no code change needed
    if (fix.isDiscussion) {
      logger.info(`   💬 This is a discussion comment — no code change needed.`);
      logger.info(`   📝 ${fix.explanation}`);
      addressed.push({ comment, fix, applied: false, skipped: true, skipReason: "discussion" });
      continue;
    }

    // Show the proposed diff
    const diffPreview = renderLineDiff(filePath, currentContent, fix.startLine, fix.endLine, fix.replacement);
    logger.info(diffPreview);
    logger.info(`\n   💡 ${fix.explanation}`);
    logger.info(`   Confidence: ${fix.confidence === "high" ? "🟢 High" : "🟡 Low"}  ·  Fully resolves: ${fix.resolves ? "yes" : "partial"}`);

    // Decide whether to apply
    let apply = false;

    if (mode === "auto") {
      apply = fix.confidence === "high";
      if (!apply) logger.info("   ⏭️  Low confidence — skipping in auto mode.");
    } else if (mode === "no-push" || mode === "interactive") {
      try {
        apply = await confirm({ message: "   Apply this fix?", default: fix.confidence === "high" });
      } catch {
        apply = false;
      }
    }

    if (!apply) {
      addressed.push({ comment, fix, applied: false, skipped: true, skipReason: "user skipped" });
      continue;
    }

    // Apply the patch
    try {
      const newContent = applyLineReplacement(currentContent, fix.startLine, fix.endLine, fix.replacement);
      const absPath = resolvePath(cwd, filePath);
      await writeFile(absPath, newContent, "utf8");
      modifiedFiles.set(filePath, newContent);
      logger.info(`   ✅ Applied.`);
      addressed.push({ comment, fix, applied: true, skipped: false });
    } catch (err) {
      logger.warn(`   ❌ Patch failed: ${(err as Error).message}`);
      addressed.push({ comment, fix, applied: false, skipped: true, skipReason: `patch error: ${(err as Error).message}` });
    }
  }

  logger.info(`\n${"─".repeat(60)}`);

  const appliedCount = addressed.filter((a) => a.applied).length;
  const filesChanged = [...new Set(addressed.filter((a) => a.applied).map((a) => a.fix.file))];

  logger.info(`\n✔ ${appliedCount} fix(es) applied across ${filesChanged.length} file(s).`);
  if (appliedCount === 0) {
    return { addressed, filesChanged: [], pushed: false, repliedCount: 0 };
  }

  // ── 4. Commit + push ──────────────────────────────────────────────────────
  let pushed = false;
  let commitSha: string | undefined;

  if (mode === "no-push") {
    logger.info("ℹ️  Changes applied locally (--no-push mode). Review and push when ready.");
  } else {
    let shouldPush = false;
    if (mode === "auto") {
      shouldPush = true;
    } else {
      try {
        const choice = await select({
          message: "What would you like to do with these changes?",
          choices: [
            { name: "Commit & push — create a commit and push to PR branch", value: "push" },
            { name: "Keep local only — I'll review the changes first",        value: "local" },
            { name: "Discard all — revert every applied fix",                 value: "discard" },
          ],
        });
        if (choice === "discard") {
          await git(["checkout", "--", ...filesChanged], cwd);
          logger.info("↩️  All changes discarded.");
          return { addressed, filesChanged: [], pushed: false, repliedCount: 0 };
        }
        shouldPush = choice === "push";
      } catch {
        shouldPush = false;
      }
    }

    if (shouldPush) {
      // Stage changed files
      const stageSpinner = ora("Staging changes…").start();
      await git(["add", ...filesChanged.map((f) => resolvePath(cwd, f))], cwd);
      stageSpinner.succeed("Changes staged.");

      // Commit
      const commitMsg = `fix: address PR #${prNumber} review comments (${appliedCount} fix${appliedCount !== 1 ? "es" : ""})`;
      const commitSpinner = ora("Committing…").start();
      const { stderr: commitErr } = await git(["commit", "-m", commitMsg], cwd);
      if (commitErr && !commitErr.toLowerCase().includes("master") && commitErr.includes("error")) {
        commitSpinner.fail(`Commit failed: ${commitErr}`);
      } else {
        commitSpinner.succeed(`Committed: "${commitMsg}"`);
        const { stdout: sha } = await git(["rev-parse", "--short", "HEAD"], cwd);
        commitSha = sha;
      }

      // Push
      const pushSpinner = ora("Pushing to remote…").start();
      const { stderr: pushErr } = await git(["push"], cwd);
      if (pushErr && pushErr.includes("error")) {
        pushSpinner.fail(`Push failed: ${pushErr}`);
      } else {
        pushSpinner.succeed("Pushed ✓");
        pushed = true;
      }
    } else {
      logger.info("ℹ️  Changes kept locally. Run `git push` when ready.");
    }
  }

  // ── 5. Reply to addressed comment threads ─────────────────────────────────
  let repliedCount = 0;
  if (pushed && commitSha) {
    const replySpinner = ora("Replying to addressed comment threads…").start();
    for (const entry of addressed) {
      if (!entry.applied) continue;
      const replyBody =
        `✅ **Addressed** in \`${commitSha}\`\n\n${entry.fix.explanation}` +
        (entry.fix.resolves ? "" : "\n\n> *(Partial fix — please re-review)*");
      try {
        await provider.replyToComment(ctx.repoSlug, prNumber, entry.comment.id, replyBody);
        repliedCount++;
      } catch {
        // Best-effort — don't abort if a reply fails
      }
    }
    replySpinner.succeed(`Replied to ${repliedCount} thread(s).`);
  }

  return { addressed, filesChanged, pushed, commitSha, repliedCount };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFallbackFix(filePath: string, line: number): AiFixResponse {
  return {
    file: filePath,
    startLine: line,
    endLine: line,
    replacement: "",
    explanation: "No fix generated.",
    confidence: "low",
    resolves: false,
    isDiscussion: true,
  };
}
