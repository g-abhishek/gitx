import type {
  AiAnalyzeTaskResponse,
  AiClient,
  AiGenerateDiffsResponse,
  AiGeneratePlanResponse,
  AiSuggestFixesResponse,
  AiSummarizeChangesResponse
} from "./types.js";

export class MockAi implements AiClient {
  async analyzeTask(input: string): Promise<AiAnalyzeTaskResponse> {
    return {
      task: input,
      intent: "unknown",
      summary: "Mock analysis (AI integration coming next).",
      assumptions: ["Repository is a Node/TypeScript project."],
      risks: ["AI is currently mocked; no real code changes will be generated."]
    };
  }

  async generatePlan(_context: unknown): Promise<AiGeneratePlanResponse> {
    return {
      steps: [
        {
          id: "step-1",
          title: "Inspect repo",
          description: "Scan structure, dependencies, and constraints."
        },
        {
          id: "step-2",
          title: "Implement change",
          description: "Apply minimal changes and add/update tests if present."
        }
      ]
    };
  }

  async generateDiffs(step: unknown): Promise<AiGenerateDiffsResponse> {
    return { stepId: String((step as { id?: string } | null)?.id ?? "unknown"), diffs: [] };
  }

  async summarizeChanges(_diff: unknown): Promise<AiSummarizeChangesResponse> {
    return { summary: "No changes (mock).", filesChanged: [] };
  }

  async suggestFixes(_comment: unknown): Promise<AiSuggestFixesResponse> {
    return { suggestedEdits: [] };
  }
}

