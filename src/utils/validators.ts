import { GitxError } from "./errors.js";

export function validateNonEmpty(label: string): (value: unknown) => true | string {
  return (value: unknown) => {
    if (typeof value !== "string") return `${label} must be a string`;
    if (value.trim().length === 0) return `${label} is required`;
    return true;
  };
}

export function assertValid(result: true | string, label = "Invalid input"): void {
  if (result === true) return;
  const message = result.startsWith(label) ? result : `${label}: ${result}`;
  throw new GitxError(message, { exitCode: 2 });
}

export function validateRepoSlug(value: unknown): true | string {
  if (typeof value !== "string") return "Repo must be a string";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Repo is required";
  if (trimmed.includes(" ")) return "Repo must not contain spaces";

  const parts = trimmed.split("/");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    return "Repo must look like owner/name";
  }

  return true;
}

export function validateOptionalRepoSlug(value: unknown): true | string {
  if (typeof value !== "string") return "Repo must be a string";
  if (value.trim().length === 0) return true;
  return validateRepoSlug(value);
}
