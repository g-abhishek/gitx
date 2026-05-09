/**
 * ImplementWorkflow
 *
 * Orchestrates the full "implement a task" flow:
 *   1. Analyze task (AI)
 *   2. Generate plan  (AI)
 *   3. Create feature branch
 *   4. For each plan step → generate diffs (AI) → apply → write files
 *   5. Stage + commit
 *   6. Push branch
 *   7. Create pull request via provider
 *
 * Returns a summary of what was done so the CLI can display it.
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
  getDefaultBranchFromGit,
  listTrackedFiles,
  readRepoFile,
  getWorkingDiff,
} from "../utils/gitOps.js";
import { logger } from "../logger/logger.js";

export interface ImplementOptions {
  task: string;
  mode: "plan" | "guided" | "semi-auto" | "auto";
  dryRun: boolean;
  /** Called after analysis; should return true to continue */
  onAnalysis?: (analysis: AiAnalyzeTaskResponse) => Promise<boolean>;
  /** Called after planning; should return true to continue */
  onPlan?: (plan: AiGeneratePlanResponse) => Promise<boolean>;
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
  const { task, dryRun } = opts;
  const cwd = gitx.cwd;

  // ── 1. Analyze ──────────────────────────────────────────────────────────────
  logger.info("🧠 Analyzing task…");
  const analysis = await gitx.ai.analyzeTask(task);

  if (opts.onAnalysis) {
    const proceed = await opts.onAnalysis(analysis);
    if (!proceed) {
      return {
        branchName: "",
        analysis,
        plan: { steps: [] },
        dryRun,
        appliedSteps: [],
        failedSteps: [],
      };
    }
  }

  // ── 2. Scan repo files (for better AI context) ───────────────────────────
  const trackedFiles = await listTrackedFiles(cwd);
  // Pick a reasonable subset of source files to pass as context (max ~20)
  const contextFiles = trackedFiles
    .filter((f) => /\.(ts|js|tsx|jsx|py|go|rs|java|rb|cs|cpp|c|h|json|yaml|yml|toml|md)$/.test(f))
    .slice(0, 20);

  const fileContents: Record<string, string> = {};
  for (const f of contextFiles.slice(0, 10)) {
    const content = await readRepoFile(f, cwd);
    if (content) fileContents[f] = content.slice(0, 3000); // Truncate very large files
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
      return {
        branchName: "",
        analysis,
        plan,
        dryRun,
        appliedSteps: [],
        failedSteps: [],
      };
    }
  }

  // ── 4. Create branch ────────────────────────────────────────────────────────
  const branchName = slugifyBranchName(task);

  if (!dryRun) {
    logger.info(`🌿 Creating branch: ${branchName}`);
    await createAndCheckoutBranch(branchName, cwd);
  } else {
    logger.info(`🌿 [dry-run] Would create branch: ${branchName}`);
  }

  // ── 5. For each step: generate diffs → apply ─────────────────────────────
  const appliedSteps: string[] = [];
  const failedSteps: Array<{ stepId: string; error: string }> = [];

  for (const step of plan.steps) {
    logger.info(`⚙️  Step [${step.id}]: ${step.title}`);

    const diffResult = await gitx.ai.generateDiffs({
      ...step,
      task,
      analysis,
      fileContents,
    });

    if (diffResult.diffs.length === 0) {
      logger.warn(`  ↳ No diffs generated for step ${step.id}`);
      continue;
    }

    for (const fileDiff of diffResult.diffs) {
      if (dryRun) {
        logger.info(`  ↳ [dry-run] Would apply diff to: ${fileDiff.path}`);
        appliedSteps.push(step.id);
        continue;
      }

      // Try applying as a unified diff first
      const applyResult = await applyUnifiedDiff(fileDiff.unifiedDiff, cwd);

      if (!applyResult.ok) {
        // Fallback: if the diff looks like full file content (not a real diff),
        // write it directly. This handles cases where the AI returns full file content.
        const isRealDiff =
          fileDiff.unifiedDiff.startsWith("---") || fileDiff.unifiedDiff.startsWith("@@");

        if (!isRealDiff) {
          try {
            await writeRepoFile(fileDiff.path, fileDiff.unifiedDiff, cwd);
            logger.info(`  ↳ Wrote file: ${fileDiff.path}`);
            appliedSteps.push(step.id);
          } catch (writeErr) {
            const msg = String((writeErr as Error).message ?? writeErr);
            logger.warn(`  ↳ Failed to write ${fileDiff.path}: ${msg}`);
            failedSteps.push({ stepId: step.id, error: msg });
          }
        } else {
          logger.warn(`  ↳ Diff apply failed for ${fileDiff.path}: ${applyResult.error ?? "unknown error"}`);
          failedSteps.push({
            stepId: step.id,
            error: applyResult.error ?? "git apply failed",
          });
        }
      } else {
        logger.info(`  ↳ Applied diff to: ${fileDiff.path}`);
        appliedSteps.push(step.id);
      }
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
    const commitMsg = buildCommitMessage(task, analysis, plan);
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

  const defaultBranch = await getDefaultBranchFromGit(cwd, gitx.config.defaultBranch);
  const workingDiff = await getWorkingDiff(cwd);
  const changeSummary = await gitx.ai.summarizeChanges({ diffs: [], rawDiff: workingDiff });

  const prTitle = buildPrTitle(task, analysis);
  const prBody = buildPrBody(task, analysis, plan, changeSummary.summary);

  logger.info("🔀 Creating pull request…");
  const pr = await provider.createPR(ctx.repoSlug, {
    title: prTitle,
    body: prBody,
    head: branchName,
    base: defaultBranch,
    draft: false,
  });

  logger.success(`✅ PR created: ${pr.url}`);

  return { branchName, analysis, plan, pr, commitSha, dryRun, appliedSteps, failedSteps };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCommitMessage(
  task: string,
  analysis: AiAnalyzeTaskResponse,
  plan: AiGeneratePlanResponse
): string {
  const prefix =
    analysis.intent === "bugfix"
      ? "fix"
      : analysis.intent === "feature"
        ? "feat"
        : analysis.intent === "refactor"
          ? "refactor"
          : analysis.intent === "chore"
            ? "chore"
            : "chore";

  const short = task.slice(0, 72);
  const steps = plan.steps.map((s) => `- ${s.title}`).join("\n");
  return `${prefix}: ${short}\n\nImplemented via gitx:\n${steps}`;
}

function buildPrTitle(task: string, analysis: AiAnalyzeTaskResponse): string {
  const prefix =
    analysis.intent === "bugfix"
      ? "fix"
      : analysis.intent === "feature"
        ? "feat"
        : analysis.intent === "refactor"
          ? "refactor"
          : analysis.intent === "chore"
            ? "chore"
            : "chore";
  return `${prefix}: ${task.slice(0, 70)}`;
}

function buildPrBody(
  task: string,
  analysis: AiAnalyzeTaskResponse,
  plan: AiGeneratePlanResponse,
  summary: string
): string {
  const steps = plan.steps.map((s) => `- **${s.title}**: ${s.description}`).join("\n");
  const assumptions = analysis.assumptions.map((a) => `- ${a}`).join("\n");
  const risks = analysis.risks.map((r) => `- ${r}`).join("\n");

  return `## Summary
${summary || analysis.summary}

## Task
${task}

## Implementation Plan
${steps}

## Assumptions
${assumptions || "- None"}

## Risks
${risks || "- None"}

---
*Generated by [gitx](https://github.com/g-abhishek/gitx)*`;
}
