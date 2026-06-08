/**
 * ImplementWorkflow
 *
 * Orchestrates the full "implement a task" flow:
 *   1. Analyze task (AI)
 *   2. Scan repo → select relevant files
 *   3. Generate plan (AI)
 *   4. Create feature branch
 *   5. For each plan step:
 *      a. Re-read files that were changed by previous steps (fresh context)
 *      b. Generate diffs (AI)
 *      c. Optionally ask user to approve (onStepDiff callback — guided mode)
 *      d. Apply diffs → fallback to full-file write if not a real diff
 *   6. Stage + commit
 *   7. Push branch
 *   8. Create pull request (base = detectBaseBranch, not always main)
 *
 * Key improvements over v1:
 * - After each step, modified files are re-read so the next generateDiffs call
 *   sees the current state, not a stale snapshot (fixes multi-step plans).
 * - PR base branch uses detectBaseBranch() instead of always targeting main/master.
 * - summarizeChanges receives the committed branch diff, not an empty working diff.
 * - Branch name and PR title include the Jira ticket key when provided.
 * - Per-step diff preview callback (used by guided mode).
 */

import type { Gitx } from "../core/gitx.js";
import type { AiAnalyzeTaskResponse, AiGeneratePlanResponse } from "../ai/types.js";
import type { PullRequest } from "../providers/base.js";
import { createProvider } from "../providers/factory.js";
import {
  slugifyBranchName,
  createAndCheckoutBranch,
  applyUnifiedDiff,
  writeRepoFile,
  stageAll,
  hasStagedChanges,
  commitChanges,
  pushBranch,
  listTrackedFiles,
  readRepoFile,
  getBranchDiff,
  detectBaseBranch,
} from "../utils/gitOps.js";
import { logger } from "../logger/logger.js";

// Max chars per file when building AI context
const FILE_CHARS_INITIAL = 3000;
const FILE_CHARS_UPDATED = 6000; // give more room for files we know are relevant

export interface ImplementOptions {
  task: string;
  mode: "plan" | "guided" | "semi-auto" | "auto";
  dryRun: boolean;
  /** When the task came from Jira, the ticket key (e.g. "PROJ-123") for branch/PR naming */
  jiraTicketKey?: string;
  /** Called after analysis; return true to continue */
  onAnalysis?: (analysis: AiAnalyzeTaskResponse) => Promise<boolean>;
  /** Called after planning; return true to continue */
  onPlan?: (plan: AiGeneratePlanResponse) => Promise<boolean>;
  /**
   * Called after diff generation for each step, before applying.
   * Return true to apply the step, false to skip.
   * Used by guided mode for per-step approval.
   */
  onStepDiff?: (
    stepTitle: string,
    diffs: Array<{ path: string; unifiedDiff: string }>
  ) => Promise<boolean>;
}

export interface ImplementResult {
  branchName: string;
  analysis: AiAnalyzeTaskResponse;
  plan: AiGeneratePlanResponse;
  pr?: PullRequest;
  commitSha?: string;
  dryRun: boolean;
  appliedSteps: string[];
  failedSteps: Array<{ stepId: string; error: string }>;
}

export async function runImplementWorkflow(
  gitx: Gitx,
  opts: ImplementOptions
): Promise<ImplementResult> {
  const { task, dryRun, jiraTicketKey } = opts;
  const cwd = gitx.cwd;

  // ── 1. Analyze ──────────────────────────────────────────────────────────────
  logger.info("🧠 Analyzing task…");
  const analysis = await gitx.ai.analyzeTask(task);

  if (opts.onAnalysis) {
    const proceed = await opts.onAnalysis(analysis);
    if (!proceed) {
      return { branchName: "", analysis, plan: { steps: [] }, dryRun, appliedSteps: [], failedSteps: [] };
    }
  }

  // ── 2. Scan repo files ───────────────────────────────────────────────────────
  logger.info("📁 Scanning repository…");
  const trackedFiles = await listTrackedFiles(cwd);

  const SOURCE_EXTS = /\.(ts|js|tsx|jsx|py|go|rs|java|rb|cs|cpp|c|h|json|yaml|yml|toml|md)$/;
  const sourceFiles = trackedFiles.filter((f) => SOURCE_EXTS.test(f));

  // Read initial file context (first 15 source files, truncated)
  const fileContents: Record<string, string> = {};
  for (const f of sourceFiles.slice(0, 15)) {
    const content = await readRepoFile(f, cwd);
    if (content) fileContents[f] = content.slice(0, FILE_CHARS_INITIAL);
  }

  // ── 3. Generate plan ────────────────────────────────────────────────────────
  logger.info("🗺️  Generating implementation plan…");
  const plan = await gitx.ai.generatePlan({
    task,
    analysis,
    repoFiles: trackedFiles,
    fileContents,
  });

  if (opts.onPlan) {
    const proceed = await opts.onPlan(plan);
    if (!proceed) {
      return { branchName: "", analysis, plan, dryRun, appliedSteps: [], failedSteps: [] };
    }
  }

  // ── 4. Create branch ────────────────────────────────────────────────────────
  // Include the Jira ticket key in the branch name when available.
  let branchName: string;
  if (jiraTicketKey) {
    const slug = task.replace(/^\[.*?\]\s*/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    branchName = `feature/${jiraTicketKey.toLowerCase()}-${slug}`.replace(/-+$/, "");
  } else {
    branchName = slugifyBranchName(task);
  }

  if (!dryRun) {
    logger.info(`🌿 Creating branch: ${branchName}`);
    await createAndCheckoutBranch(branchName, cwd);
  } else {
    logger.info(`🌿 [dry-run] Would create branch: ${branchName}`);
  }

  // ── 5. For each step: generate diffs → apply ──────────────────────────────
  const appliedSteps: string[] = [];
  const failedSteps: Array<{ stepId: string; error: string }> = [];

  // mutableFileContents is kept in sync with disk after each step so the next
  // step's generateDiffs call sees the current state of changed files.
  const mutableFileContents: Record<string, string> = { ...fileContents };

  for (const step of plan.steps) {
    logger.info(`⚙️  Step [${step.id}]: ${step.title}`);

    const diffResult = await gitx.ai.generateDiffs({
      ...step,
      task,
      analysis,
      fileContents: mutableFileContents,
    });

    if (diffResult.diffs.length === 0) {
      logger.warn(`  ↳ No diffs generated for step ${step.id}`);
      continue;
    }

    // ── Per-step callback (guided mode): show diffs and ask ────────────────
    if (opts.onStepDiff) {
      const applyStep = await opts.onStepDiff(step.title, diffResult.diffs);
      if (!applyStep) {
        logger.info(`  ↳ Skipped by user: step ${step.id}`);
        continue;
      }
    }

    const modifiedPaths: string[] = [];

    for (const fileDiff of diffResult.diffs) {
      if (dryRun) {
        logger.info(`  ↳ [dry-run] Would apply diff to: ${fileDiff.path}`);
        appliedSteps.push(step.id);
        continue;
      }

      const applyResult = await applyUnifiedDiff(fileDiff.unifiedDiff, cwd);

      if (!applyResult.ok) {
        // Fallback: if content doesn't look like a real unified diff, write directly.
        // This handles AI responses that return full file content instead of patches.
        const isRealDiff =
          fileDiff.unifiedDiff.startsWith("---") || fileDiff.unifiedDiff.startsWith("@@");

        if (!isRealDiff) {
          try {
            await writeRepoFile(fileDiff.path, fileDiff.unifiedDiff, cwd);
            logger.info(`  ↳ Wrote file: ${fileDiff.path}`);
            appliedSteps.push(step.id);
            modifiedPaths.push(fileDiff.path);
          } catch (writeErr) {
            const msg = String((writeErr as Error).message ?? writeErr);
            logger.warn(`  ↳ Failed to write ${fileDiff.path}: ${msg}`);
            failedSteps.push({ stepId: step.id, error: msg });
          }
        } else {
          logger.warn(`  ↳ Diff apply failed for ${fileDiff.path}: ${applyResult.error ?? "unknown"}`);
          failedSteps.push({ stepId: step.id, error: applyResult.error ?? "git apply failed" });
        }
      } else {
        logger.info(`  ↳ Applied diff to: ${fileDiff.path}`);
        appliedSteps.push(step.id);
        modifiedPaths.push(fileDiff.path);
      }
    }

    // ── Refresh file context for the next step ────────────────────────────
    // After applying a step, re-read every file that was touched so the next
    // step's AI call gets current content, not the original snapshot.
    for (const changedPath of modifiedPaths) {
      try {
        const updated = await readRepoFile(changedPath, cwd);
        if (updated != null) {
          mutableFileContents[changedPath] = updated.slice(0, FILE_CHARS_UPDATED);
        }
      } catch { /* non-fatal */ }
    }
  }

  if (dryRun) {
    logger.info("🏁 Dry run complete — no changes committed.");
    return { branchName, analysis, plan, dryRun, appliedSteps, failedSteps };
  }

  // ── 6. Commit ───────────────────────────────────────────────────────────────
  await stageAll(cwd);
  let commitSha: string | undefined;

  if (await hasStagedChanges(cwd)) {
    const commitMsg = buildCommitMessage(task, analysis, plan, jiraTicketKey);
    commitSha = await commitChanges(commitMsg, cwd);
    logger.success(`📦 Committed: ${commitSha.slice(0, 8)}`);
  } else {
    logger.warn("⚠️  No changes to commit — AI may not have generated any diffs.");
    return { branchName, analysis, plan, dryRun, appliedSteps, failedSteps, commitSha };
  }

  // ── 7. Push ─────────────────────────────────────────────────────────────────
  logger.info(`🚀 Pushing branch: ${branchName}`);
  await pushBranch(branchName, cwd);

  // ── 8. Create PR ────────────────────────────────────────────────────────────
  const ctx = await gitx.getRepoContext();
  const provider = createProvider(ctx);

  // Use detectBaseBranch to find the real parent branch (handles nested branches
  // and feature-from-feature scenarios). Fall back to configured defaultBranch.
  let baseBranch: string;
  try {
    baseBranch = await detectBaseBranch(cwd);
  } catch {
    baseBranch = gitx.config.defaultBranch ?? "main";
  }

  // Summarize the committed diff — NOT the working diff (which is empty post-commit)
  let changeSummary = analysis.summary;
  try {
    const branchDiff = await getBranchDiff(cwd, baseBranch);
    if (branchDiff) {
      const summaryResult = await gitx.ai.summarizeChanges({ diffs: [], rawDiff: branchDiff });
      changeSummary = summaryResult.summary || analysis.summary;
    }
  } catch { /* use analysis summary as fallback */ }

  const prTitle = buildPrTitle(task, analysis, jiraTicketKey);
  const prBody = buildPrBody(
    task, analysis, plan, changeSummary, jiraTicketKey, gitx.config.jira?.url
  );

  logger.info("🔀 Creating pull request…");
  let pr: PullRequest | undefined;
  try {
    pr = await provider.createPR(ctx.repoSlug, {
      title: prTitle,
      body: prBody,
      head: branchName,
      base: baseBranch,
      draft: false,
    });
    logger.success(`✅ PR created: ${pr.url}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`⚠️  PR creation failed: ${msg}`);
  }

  return { branchName, analysis, plan, pr, commitSha, dryRun, appliedSteps, failedSteps };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function intentPrefix(intent: AiAnalyzeTaskResponse["intent"]): string {
  switch (intent) {
    case "bugfix":   return "fix";
    case "feature":  return "feat";
    case "refactor": return "refactor";
    case "chore":    return "chore";
    default:         return "chore";
  }
}

function buildCommitMessage(
  task: string,
  analysis: AiAnalyzeTaskResponse,
  plan: AiGeneratePlanResponse,
  jiraTicketKey?: string
): string {
  const prefix = intentPrefix(analysis.intent);
  const scope = jiraTicketKey ? `(${jiraTicketKey})` : "";
  // Strip "[PROJ-123] " prefix from the task if Jira key is in the scope
  const short = task.replace(/^\[.*?\]\s*/, "").split("\n")[0]?.slice(0, 72) ?? task.slice(0, 72);
  const steps = plan.steps.map((s) => `- ${s.title}`).join("\n");
  const jiraLine = jiraTicketKey ? `\nJira: ${jiraTicketKey}` : "";
  return `${prefix}${scope}: ${short}\n\nImplemented via gitx:\n${steps}${jiraLine}`;
}

function buildPrTitle(
  task: string,
  analysis: AiAnalyzeTaskResponse,
  jiraTicketKey?: string
): string {
  const prefix = intentPrefix(analysis.intent);
  const scope = jiraTicketKey ? `(${jiraTicketKey})` : "";
  const short = task.replace(/^\[.*?\]\s*/, "").split("\n")[0]?.slice(0, 70) ?? task.slice(0, 70);
  return `${prefix}${scope}: ${short}`;
}

function buildPrBody(
  task: string,
  analysis: AiAnalyzeTaskResponse,
  plan: AiGeneratePlanResponse,
  summary: string,
  jiraTicketKey?: string,
  jiraBaseUrl?: string
): string {
  const steps = plan.steps.map((s) => `- **${s.title}**: ${s.description}`).join("\n");
  const assumptions = analysis.assumptions.map((a) => `- ${a}`).join("\n");
  const risks = analysis.risks.map((r) => `- ${r}`).join("\n");

  const jiraSection =
    jiraTicketKey && jiraBaseUrl
      ? `\n## Jira Ticket\n[${jiraTicketKey}](${jiraBaseUrl.replace(/\/$/, "")}/browse/${jiraTicketKey})\n`
      : jiraTicketKey
        ? `\n## Jira Ticket\n${jiraTicketKey}\n`
        : "";

  // Use first line of task only (the summary line), strip "[PROJ-123]" prefix
  const displayTask = task.replace(/^\[.*?\]\s*/, "").split("\n")[0] ?? task;

  return `## Summary
${summary || analysis.summary}
${jiraSection}
## Task
${displayTask}

## Implementation Plan
${steps}

## Assumptions
${assumptions || "- None"}

## Risks
${risks || "- None"}

---
*Generated by [gitx](https://github.com/g-abhishek/gitx)*`;
}
