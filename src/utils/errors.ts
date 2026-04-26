export class GitxError extends Error {
  public readonly exitCode: number;
  public readonly cause?: unknown;

  constructor(message: string, options?: { exitCode?: number; cause?: unknown }) {
    super(message);
    this.name = "GitxError";
    this.exitCode = options?.exitCode ?? 1;
    this.cause = options?.cause;
  }
}

