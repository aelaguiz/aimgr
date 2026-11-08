import { saveLocalClaudeLogin } from "../../src/credentials/claude-local.js";

export const CLAUDE_TEST_ENVIRONMENT = Object.freeze({ binding: "a".repeat(64) });
export const readClaudeTestEnvironment = () => CLAUDE_TEST_ENVIRONMENT;

// Enroll only the synthetic test bundle through the local ownership path.
export async function localClaudeFixture(homeDir, record) {
  if (!record.credential?.nativeClaudeBundle || !record.identity?.accountUuid || !record.identity?.organizationUuid) return;
  return saveLocalClaudeLogin({
    homeDir, label: record.label, metadata: record, environment: CLAUDE_TEST_ENVIRONMENT,
    command: process.execPath, nativeClaudeBundle: record.credential.nativeClaudeBundle,
    assertStopped: async () => {},
  });
}
