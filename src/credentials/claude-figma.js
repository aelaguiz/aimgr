import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { readClaudeLaunchState } from "../privacy/claude-launch-inputs.js";
import { prepareClaudeCliLaunch, runClaudeCli, runClaudeCliNoninteractive } from "../targets/claude-runner.js";
import {
  FIGMA_MCP_URL,
  ensureClaudeFigmaGrantRoot,
  readClaudeFigmaGrant,
  selectClaudeFigmaNativeGrant,
  writeClaudeFigmaGrant,
} from "./claude-figma-store.js";

const REFRESH_WINDOW_MS = 24 * 60 * 60_000;
const NATIVE_SERVER_NAME = "figma";

export function normalizeFigmaEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email) ? email : null;
}

async function withFigmaGrantLock(homeDir, operation) {
  const root = ensureClaudeFigmaGrantRoot({ homeDir });
  let compromised = false;
  const release = await lockfile.lock(root, {
    retries: { retries: 8, minTimeout: 100, maxTimeout: 500 },
    onCompromised: () => { compromised = true; },
  });
  try {
    return await operation(() => {
      if (compromised) throw new Error("The Figma grant lock was lost.");
    });
  } finally {
    await release();
  }
}

async function withStagedClaude({ homeDir, email, callbackPort, native }, operation) {
  const root = ensureClaudeFigmaGrantRoot({ homeDir });
  const stagingHome = path.join(root, `.login-staging-${randomUUID()}`);
  const configDir = path.join(stagingHome, ".claude");
  const cwd = path.join(stagingHome, "cwd");
  fs.mkdirSync(stagingHome, { mode: 0o700 });
  try {
    fs.mkdirSync(configDir, { mode: 0o700 });
    fs.mkdirSync(cwd, { mode: 0o700 });
    fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({
      mcpServers: {
        [NATIVE_SERVER_NAME]: {
          type: "http",
          url: FIGMA_MCP_URL,
          ...(callbackPort === undefined ? {} : { oauth: { callbackPort } }),
        },
      },
    }), { mode: 0o600, flag: "wx" });
    const credentials = path.join(configDir, ".credentials.json");
    if (native) {
      fs.writeFileSync(credentials, JSON.stringify(native), { mode: 0o600, flag: "wx" });
    }
    await operation({ userHomeDir: homeDir, homeDir: stagingHome, configDir, cwd });
    const grant = selectClaudeFigmaNativeGrant(readClaudeLaunchState(credentials, { optional: true }));
    return grant ? { ...grant, email } : null;
  } finally {
    fs.rmSync(stagingHome, { recursive: true, force: true });
  }
}

function stagedEnvironment(source = process.env) {
  // The Figma-only command has no account selectors, caller hooks or task credentials.
  const keys = ["PATH", "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "AIMGR_CLAUDE_ARTIFACT_SET"];
  return { ...Object.fromEntries(keys.filter(key => typeof source[key] === "string")
    .map(key => [key, source[key]])), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

function responseEmail(result) {
  const identity = value => normalizeFigmaEmail(value?.whoami?.email ?? value?.email);
  if (result?.isError) return null;
  if (result?.structuredContent) return identity(result.structuredContent);
  const emails = new Set();
  for (const item of result?.content ?? []) {
    if (item.type !== "text") continue;
    try {
      const email = identity(JSON.parse(item.text));
      if (email) emails.add(email);
    } catch { /* A text block can contain instructions instead of identity. */ }
  }
  return emails.size === 1 ? emails.values().next().value : null;
}

export async function verifyClaudeFigmaIdentity({ email, accessToken }, { fetchImpl = fetch } = {}) {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const client = new Client({ name: "aimgr", version: "1" });
  const signal = AbortSignal.timeout(15_000);
  const transport = new StreamableHTTPClientTransport(new URL(FIGMA_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: (input, options) => {
      if (String(input) !== FIGMA_MCP_URL) throw new Error("Unexpected Figma MCP endpoint.");
      return fetchImpl(input, {
        ...options,
        redirect: "error",
        signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
      });
    },
  });
  let actual;
  try {
    await client.connect(transport, { signal });
    actual = responseEmail(await client.callTool({ name: "whoami", arguments: {} }, undefined, { signal }));
  } catch {
    throw new Error("Figma MCP could not verify the signed-in account.");
  } finally {
    await client.close();
  }
  if (!actual) throw new Error("Figma MCP did not return an account email.");
  if (actual !== email) throw new Error("The signed-in Figma account differs from the requested email.");
}

export async function loginClaudeFigmaGrant(context, { email, callbackPort } = {}) {
  const { homeDir, resolveExecutableOnPathImpl: resolveExecutable } = context;
  const command = resolveExecutable?.("claude");
  const prepare = resolveExecutable?.prepareClaudeCliLaunchImpl ?? prepareClaudeCliLaunch;
  let grant;
  try {
    grant = await withStagedClaude({ homeDir, email, callbackPort }, async launch => {
      const preparedLaunch = await prepare({ ...launch, command });
      const signal = AbortSignal.timeout(5 * 60_000);
      const result = await (context.runClaudeCliImpl ?? runClaudeCli)({
        ...launch, preparedLaunch, command: preparedLaunch.command,
        args: ["mcp", "login", NATIVE_SERVER_NAME, "--no-browser"],
        env: stagedEnvironment(context.env), signal,
      });
      if (signal.aborted || result?.status !== 0 || result?.signal) throw new Error();
    });
  } catch {
    throw new Error("Claude did not complete Figma sign-in in the approved native runtime.");
  }
  if (!grant || grant.expiresAt <= Date.now()) throw new Error("Claude did not produce a usable Figma grant.");
  await verifyClaudeFigmaIdentity(grant, context);
  try {
    await withFigmaGrantLock(homeDir, assertOwned => {
      assertOwned();
      writeClaudeFigmaGrant({ homeDir, email, native: grant.native });
    });
  } catch {
    throw new Error("The verified Figma grant could not be saved on this machine.");
  }
  return grant;
}

export async function maintainClaudeFigmaGrant(context, { force = false } = {}) {
  const { homeDir } = context;
  const read = () => readClaudeFigmaGrant({ homeDir });
  const due = grant => force || grant.expiresAt <= Date.now() + REFRESH_WINDOW_MS;
  const skipped = { outcome: "skipped", reason: "not_enrolled" };
  const healthy = { outcome: "unchanged", reason: "not_due" };
  try {
    const grant = read();
    if (!grant) return skipped;
    if (!due(grant)) return healthy;
    return await withFigmaGrantLock(homeDir, async assertOwned => {
      const current = read();
      if (!current) return skipped;
      if (!due(current)) return healthy;
      // Only the private copy is expired here. Native owns the refresh exchange
      // and may rotate the refresh token along with the access token.
      current.native.mcpOAuth[current.key].expiresAt = 1;
      const renewed = await withStagedClaude({ ...current, homeDir }, async launch => {
        const result = await (context.runClaudeCliNoninteractiveImpl ?? runClaudeCliNoninteractive)({
          ...launch, command: context.resolveExecutableOnPathImpl?.("claude"),
          args: ["mcp", "get", NATIVE_SERVER_NAME], env: stagedEnvironment(context.env),
          timeoutMs: 30_000,
        });
        if (result?.status !== 0 || result?.signal || result?.timedOut) throw new Error();
      });
      if (!renewed || renewed.expiresAt <= Date.now()) throw new Error();
      assertOwned();
      writeClaudeFigmaGrant({ homeDir, email: current.email, native: renewed.native });
      return { outcome: "refreshed", reason: "grant_renewed" };
    });
  } catch {
    return { outcome: "retryable", reason: "figma_refresh_unavailable" };
  }
}
