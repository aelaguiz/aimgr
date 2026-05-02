import fs from "node:fs";
import path from "node:path";
import { writeJson } from "./files.js";

export function installFakeOpenclaw({
  rootDir,
  agentsList,
  bindingsList = [],
  failConfigGetKeys = [],
  configGetRawByKey = {},
  failConfigSetPaths = [],
  failGatewayRestart = false,
  failSessionPatchKeys = [],
}) {
  const binDir = path.join(rootDir, "bin");
  const agentsListPath = path.join(rootDir, "agents-list.json");
  const bindingsListPath = path.join(rootDir, "bindings-list.json");
  const sessionPatchLogPath = path.join(rootDir, "openclaw-sessions-patch-log.json");
  const restartLogPath = path.join(rootDir, "openclaw-gateway-restarts.json");
  fs.mkdirSync(binDir, { recursive: true });
  writeJson(agentsListPath, agentsList);
  writeJson(bindingsListPath, bindingsList);
  writeJson(sessionPatchLogPath, []);
  writeJson(restartLogPath, []);
  const scriptPath = path.join(binDir, "openclaw");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const configGetFailures = new Set(${JSON.stringify(failConfigGetKeys)});
const configGetRawByKey = ${JSON.stringify(configGetRawByKey)};
const configSetFailures = new Set(${JSON.stringify(failConfigSetPaths)});
if (args[0] === "config" && args[1] === "get" && args.includes("--json")) {
  const key = args[2];
  if (configGetFailures.has(key)) {
    process.stderr.write("fake config get failed for " + key);
    process.exit(24);
  }
  if (Object.prototype.hasOwnProperty.call(configGetRawByKey, key)) {
    process.stdout.write(String(configGetRawByKey[key]));
    process.exit(0);
  }
  if (key === "agents.list") {
    process.stdout.write(fs.readFileSync(${JSON.stringify(agentsListPath)}, "utf8"));
    process.exit(0);
  }
  if (key === "bindings") {
    process.stdout.write(fs.readFileSync(${JSON.stringify(bindingsListPath)}, "utf8"));
    process.exit(0);
  }
  process.stderr.write("unexpected config key: " + key);
  process.exit(2);
}
if (args[0] === "config" && args[1] === "set") {
  const strictJsonIdx = args.indexOf("--strict-json");
  const pathArg = strictJsonIdx >= 0 ? args[strictJsonIdx + 1] : null;
  const valueRaw = strictJsonIdx >= 0 ? args[strictJsonIdx + 2] : null;
  if (configSetFailures.has(pathArg)) {
    process.stderr.write("fake config set failed for " + pathArg);
    process.exit(25);
  }
  const match = typeof pathArg === "string" ? pathArg.match(/^agents\\.list\\[(\\d+)\\]\\.model(?:\\.(primary|fallbacks))?$/) : null;
  if (match && typeof valueRaw === "string") {
    const list = JSON.parse(fs.readFileSync(${JSON.stringify(agentsListPath)}, "utf8"));
    const idx = Number.parseInt(match[1], 10);
    const field = match[2] || null;
    const nextValue = JSON.parse(valueRaw);
    const entry = list[idx] || {};
    if (!field) {
      entry.model = nextValue;
    } else {
      const currentModel = entry && typeof entry.model === "object" && entry.model !== null ? entry.model : {};
      currentModel[field] = nextValue;
      entry.model = currentModel;
    }
    list[idx] = entry;
    fs.writeFileSync(${JSON.stringify(agentsListPath)}, JSON.stringify(list, null, 2) + "\\n");
  }
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "call" && args[2] === "sessions.list") {
  process.stderr.write("fake gateway unavailable");
  process.exit(1);
}
if (args[0] === "gateway" && args[1] === "call" && args[2] === "sessions.patch") {
  const paramsIdx = args.indexOf("--params");
  const paramsRaw = paramsIdx >= 0 ? args[paramsIdx + 1] : "{}";
  const params = JSON.parse(paramsRaw);
  const failedKeys = new Set(${JSON.stringify(failSessionPatchKeys)});
  if (failedKeys.has(params.key)) {
    process.stderr.write("fake session patch failed for " + params.key);
    process.exit(42);
  }
  const existing = fs.existsSync(${JSON.stringify(sessionPatchLogPath)})
    ? JSON.parse(fs.readFileSync(${JSON.stringify(sessionPatchLogPath)}, "utf8"))
    : [];
  existing.push({ at: new Date().toISOString(), args });
  fs.writeFileSync(${JSON.stringify(sessionPatchLogPath)}, JSON.stringify(existing, null, 2) + "\\n");
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "restart") {
  const existing = fs.existsSync(${JSON.stringify(restartLogPath)})
    ? JSON.parse(fs.readFileSync(${JSON.stringify(restartLogPath)}, "utf8"))
    : [];
  existing.push({ at: new Date().toISOString(), ok: ${JSON.stringify(!failGatewayRestart)} });
  fs.writeFileSync(${JSON.stringify(restartLogPath)}, JSON.stringify(existing, null, 2) + "\\n");
  if (${JSON.stringify(failGatewayRestart)}) {
    process.stderr.write("fake restart failed");
    process.exit(23);
  }
  process.stdout.write("restarted\\n");
  process.exit(0);
}
process.stderr.write("unexpected openclaw args: " + args.join(" "));
process.exit(2);
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return binDir;
}

export function installFakeClaude({ rootDir }) {
  const binDir = path.join(rootDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "claude");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);

if (args[0] === "auth" && args[1] === "status") {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: claude auth status [options]\\n\\nShow authentication status\\n\\nOptions:\\n  -h, --help  Display help for command\\n  --json      Output as JSON (default)\\n  --text      Output as human-readable text\\n");
    process.exit(0);
  }

  const home = process.env.HOME || process.cwd();
  const authPath = path.join(home, ".claude", ".credentials.json");
  const appStatePath = path.join(home, ".claude.json");
  let payload = {
    loggedIn: false,
    authMethod: "none",
    apiProvider: "none",
    email: null,
    orgId: null,
    orgName: null,
    subscriptionType: null,
  };

  if (typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === "string" && process.env.CLAUDE_CODE_OAUTH_TOKEN.trim()) {
    payload = {
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      email: null,
      orgId: null,
      orgName: null,
      subscriptionType: null,
    };
  } else if (fs.existsSync(authPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (process.env.CLAUDE_AUTH_STATUS_MUTATES === "1" && parsed && typeof parsed === "object" && parsed.claudeAiOauth) {
        parsed.claudeAiOauth = {
          ...parsed.claudeAiOauth,
          subscriptionType: null,
          rateLimitTier: null,
          expiresAt: Date.now() + 3600_000,
        };
        fs.writeFileSync(authPath, JSON.stringify(parsed, null, 2) + "\\n");
      }
      const oauth = parsed && typeof parsed === "object" && parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object"
        ? parsed.claudeAiOauth
        : null;
      const scopes = Array.isArray(oauth && oauth.scopes) ? oauth.scopes.filter((entry) => typeof entry === "string" && entry.trim()) : [];
      const loggedIn =
        oauth
        && typeof oauth.accessToken === "string" && oauth.accessToken.trim()
        && typeof oauth.refreshToken === "string" && oauth.refreshToken.trim()
        && Number.isFinite(Number(oauth.expiresAt))
        && typeof oauth.subscriptionType === "string" && oauth.subscriptionType.trim()
        && typeof oauth.rateLimitTier === "string" && oauth.rateLimitTier.trim()
        && scopes.length > 0;
      if (loggedIn) {
        let oauthAccount = null;
        if (fs.existsSync(appStatePath)) {
          const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
          oauthAccount =
            appState && typeof appState === "object" && appState.oauthAccount && typeof appState.oauthAccount === "object"
              ? appState.oauthAccount
              : null;
        }
        payload = {
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: oauthAccount && typeof oauthAccount.emailAddress === "string" ? oauthAccount.emailAddress.trim() : null,
          orgId: oauthAccount && typeof oauthAccount.organizationUuid === "string" ? oauthAccount.organizationUuid.trim() : null,
          orgName: oauthAccount && typeof oauthAccount.organizationName === "string" ? oauthAccount.organizationName.trim() : null,
          subscriptionType: oauth.subscriptionType.trim(),
        };
      }
    } catch (err) {
      process.stderr.write(String(err && err.message ? err.message : err));
      process.exit(1);
    }
  }

  process.stdout.write(JSON.stringify(payload, null, 2) + "\\n");
  process.exit(0);
}

process.stderr.write("unexpected claude args: " + args.join(" "));
process.exit(2);
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return binDir;
}

export function readFakeOpenclawRestarts(rootDir) {
  const restartLogPath = path.join(rootDir, "openclaw-gateway-restarts.json");
  return JSON.parse(fs.readFileSync(restartLogPath, "utf8"));
}

export function readFakeOpenclawSessionPatches(rootDir) {
  const sessionPatchLogPath = path.join(rootDir, "openclaw-sessions-patch-log.json");
  return JSON.parse(fs.readFileSync(sessionPatchLogPath, "utf8"));
}
