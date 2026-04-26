export interface AiAnalyzeTaskResponse {
  task: string;
  intent: "refactor" | "bugfix" | "feature" | "chore" | "unknown";
  summary: string;
  assumptions: string[];
  risks: string[];
}

export interface AiPlanStep {
  id: string;
  title: string;
  description: string;
}

export interface AiGeneratePlanResponse {
  steps: AiPlanStep[];
}

export interface AiGenerateDiffsResponse {
  stepId: string;
  diffs: Array<{ path: string; unifiedDiff: string }>;
}

export interface AiSummarizeChangesResponse {
  summary: string;
  filesChanged: Array<{ path: string; changeType: "add" | "modify" | "delete" }>;
}

export interface AiSuggestFixesResponse {
  suggestedEdits: Array<{ path: string; rationale: string; unifiedDiff: string }>;
}

export interface AiClient {
  analyzeTask(input: string): Promise<AiAnalyzeTaskResponse>;
  generatePlan(context: unknown): Promise<AiGeneratePlanResponse>;
  generateDiffs(step: unknown): Promise<AiGenerateDiffsResponse>;
  summarizeChanges(diff: unknown): Promise<AiSummarizeChangesResponse>;
  suggestFixes(comment: unknown): Promise<AiSuggestFixesResponse>;
}

