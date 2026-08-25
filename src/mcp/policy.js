// Argv policy for the MCP `aim_exec` tool. Pure and unit-testable: the server
// asks this module whether a command is safe to spawn before it spawns anything.
// Interactive lanes (OAuth, TUIs, stdio protocols, infinite watch loops) must be
// rejected with an actionable reason instead of hanging an MCP client.

export const AIM_MCP_ALLOWED_COMMANDS = Object.freeze([
  "status",
  "redis",
  "label",
  "grok",
  "rebalance",
  "auth",
  "codex",
  "hermes",
  "claude",
  "pi",
  "prime",
  "routine",
  "sakana",
  "browser",
  "help",
]);

const ALLOWED = new Set(AIM_MCP_ALLOWED_COMMANDS);

function reject(reason) {
  return { ok: false, reason };
}

export function validateAimArgv(argv) {
  if (!Array.isArray(argv)) {
    return reject('argv must be an array of strings, e.g. ["status","--json"].');
  }
  if (argv.length === 0) {
    return reject('argv must not be empty. Run ["help"] for the full aim command surface.');
  }
  if (!argv.every((entry) => typeof entry === "string")) {
    return reject('argv must contain strings only, e.g. ["claude","status","--json"].');
  }

  const [command, ...rest] = argv;

  if (command === "login") {
    return reject(
      "`aim login` is an interactive OAuth lane and is not available over MCP; remote login lands in Phase 2.",
    );
  }
  if (command === "credential-helper") {
    return reject(
      "`aim credential-helper` is a machine stdin/stdout protocol and would hang over MCP; it has no interactive use.",
    );
  }
  if (!ALLOWED.has(command)) {
    return reject(
      `Unknown aim command: ${command}. A bare token is the interactive label panel; not available over MCP. `
      + 'Run ["help"] for the full aim command surface.',
    );
  }

  if ((command === "claude" || command === "prime") && (rest[0] === "run" || rest[0] === "resume")) {
    return reject(
      `\`aim ${command} ${rest[0]}\` starts an interactive TUI and is not available over MCP.`,
    );
  }

  if ((command === "codex" || command === "hermes") && rest[0] === "watch" && !rest.includes("--once")) {
    return reject(
      `\`aim ${command} watch\` loops forever without \`--once\`. Re-run as ["${command}","watch","--once"].`,
    );
  }

  return { ok: true };
}
