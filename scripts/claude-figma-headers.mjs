import { FIGMA_MCP_NAME, FIGMA_MCP_URL, readClaudeFigmaGrant } from "../src/credentials/claude-figma-store.js";

if (process.env.CLAUDE_CODE_MCP_SERVER_NAME !== FIGMA_MCP_NAME
  || process.env.CLAUDE_CODE_MCP_SERVER_URL !== FIGMA_MCP_URL) {
  process.exitCode = 1;
} else {
  try {
    const grant = readClaudeFigmaGrant({ homeDir: process.argv[2] });
    if (grant && grant.expiresAt > Date.now()) {
      process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${grant.accessToken}` })}\n`);
    } else process.exitCode = 1;
  } catch { process.exitCode = 1; }
}
