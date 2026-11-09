import { workingDirectories } from "./working-directories.js";

/** The same OS work areas as Codex, with Claude's independent extra roots. */
export function claudeWorkingDirectories(options = {}) {
  return workingDirectories({ ...options, configKey: "claudeWorkingDirectories" });
}
