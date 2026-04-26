import type { AutonomyMode } from "../types/modes.js";
import { GitxError } from "./errors.js";

export function parseAutonomyMode(value: unknown): AutonomyMode {
  if (value === "plan" || value === "guided" || value === "semi-auto" || value === "auto") return value;
  throw new GitxError("Invalid --mode. Use plan|guided|semi-auto|auto.", { exitCode: 2 });
}

