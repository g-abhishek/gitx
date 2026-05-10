import type {
  AiAnalyzeTaskResponse,
  AiClient,
  AiCommitMessageResponse,
  AiGenerateDiffsResponse,
  AiGeneratePlanResponse,
  AiReviewPRResponse,
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

  async reviewPR(_context: unknown): Promise<AiReviewPRResponse> {
    return {
      summary: "AI review is not available (ANTHROPIC_API_KEY not set). Set the key and retry.",
      issues: [],
      positives: [],
      verdict: "comment",
    };
  }

  async generateCommitMessage(_diff: string): Promise<AiCommitMessageResponse> {
    return {
      subject: "chore: update files",
      body: undefined,
    };
  }

  async generatePrContent(_commits: string[], _diff: string, _stat?: string): Promise<import("./types.js").AiPrContentResponse> {
    return {
      title: "Update branch",
      body: "",
    };
  }

  async resolveConflict(filePath: string, conflictContent: string): Promise<import("./types.js").AiConflictResolutionResponse> {
    return {
      resolved: conflictContent,
      confidence: "low",
      explanation: `AI conflict resolution is not available (no AI provider configured). Please resolve ${filePath} manually.`,
    };
  }

  async reviewPRDetailed(
    _context: Parameters<import("./types.js").AiClient["reviewPRDetailed"]>[0]
  ): Promise<import("./types.js").AiDetailedReviewResponse> {
    return {
      summary: "AI PR review is not available (no AI provider configured). Set ANTHROPIC_API_KEY and retry.",
      verdict: "comment",
      issues: [],
      inlineComments: [],
      positives: [],
      testingNotes: "Test the changes manually.",
      checklist: [],
    };
  }

  async generateFix(
    context: Parameters<import("./types.js").AiClient["generateFix"]>[0]
  ): Promise<import("./types.js").AiFixResponse> {
    return {
      file: context.filePath,
      startLine: context.line,
      endLine: context.line,
      replacement: "",
      explanation: "AI fix generation is not available (no AI provider configured).",
      confidence: "low",
      resolves: false,
      isDiscussion: true,
    };
  }
}
