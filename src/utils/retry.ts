/**
 * Retry an async operation with exponential backoff.
 * Only retries on network/5xx errors — never on 4xx (auth, not-found, etc.)
 */

import { isAxiosError } from "axios";

export interface RetryOptions {
  attempts?: number;      // total attempts (default: 3)
  baseDelayMs?: number;   // initial delay in ms (default: 500)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.attempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 500;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Never retry on 4xx client errors
      if (isAxiosError(err)) {
        const status = err.response?.status;
        if (status && status >= 400 && status < 500) throw err;
      }

      // Don't wait after the last attempt
      if (attempt === maxAttempts) break;

      const delay = baseDelay * Math.pow(2, attempt - 1); // 500, 1000, 2000…
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
