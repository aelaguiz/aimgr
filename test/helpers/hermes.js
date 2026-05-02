import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeJson } from "./files.js";

export function resolveSqlite3ForTests() {
  const candidates = [
    process.env.SQLITE3_BIN,
    path.join(process.env.HOME || "", "Library", "Android", "sdk", "platform-tools", "sqlite3"),
    "/opt/homebrew/bin/sqlite3",
    "/usr/local/bin/sqlite3",
    "/usr/bin/sqlite3",
    "sqlite3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "sqlite3") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "sqlite3";
}

export function sqlQuote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function writeHermesAuthFile(
  home,
  homeId,
  { accessToken, refreshToken, activeProvider = "openai-codex", credentialPool = undefined },
) {
  const authPath = path.join(home, ".hermes", "profiles", homeId, "auth.json");
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    active_provider: activeProvider,
    providers: {
      "openai-codex": {
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
        },
        last_refresh: new Date().toISOString(),
        auth_mode: "chatgpt",
      },
    },
  };
  const normalizedCredentialPool =
    credentialPool === undefined
      ? {
          "openai-codex": [
            {
              id: "codex01",
              label: "device_code",
              auth_type: "oauth",
              priority: 0,
              source: "device_code",
              access_token: accessToken,
              refresh_token: refreshToken,
              base_url: "https://chatgpt.com/backend-api/codex",
              request_count: 0,
            },
          ],
        }
      : credentialPool;
  if (normalizedCredentialPool !== null) {
    payload.credential_pool = normalizedCredentialPool;
  }
  writeJson(authPath, payload);
  return authPath;
}

export function writeHermesStateDb(home, homeId, sessions = []) {
  const stateDbPath = path.join(home, ".hermes", "profiles", homeId, "state.db");
  fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
  const sqlite3 = resolveSqlite3ForTests();
  const schema = `
DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  user_id TEXT,
  model TEXT,
  model_config TEXT,
  system_prompt TEXT,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  end_reason TEXT,
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  billing_provider TEXT,
  billing_base_url TEXT,
  billing_mode TEXT,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  cost_status TEXT,
  cost_source TEXT,
  pricing_version TEXT,
  title TEXT
);`;
  const inserts = (Array.isArray(sessions) ? sessions : []).map((session, index) => {
    const id = session.id ?? `session_${index + 1}`;
    const source = session.source ?? "slack";
    const startedAt = Number.isFinite(Number(session.startedAt)) ? Number(session.startedAt) : Date.now() / 1000;
    const inputTokens = Number.isFinite(Number(session.inputTokens)) ? Number(session.inputTokens) : 0;
    const outputTokens = Number.isFinite(Number(session.outputTokens)) ? Number(session.outputTokens) : 0;
    const cacheReadTokens = Number.isFinite(Number(session.cacheReadTokens)) ? Number(session.cacheReadTokens) : 0;
    const cacheWriteTokens = Number.isFinite(Number(session.cacheWriteTokens)) ? Number(session.cacheWriteTokens) : 0;
    const reasoningTokens = Number.isFinite(Number(session.reasoningTokens)) ? Number(session.reasoningTokens) : 0;
    return `INSERT INTO sessions (
      id, source, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
    ) VALUES (
      ${sqlQuote(id)}, ${sqlQuote(source)}, ${startedAt}, ${inputTokens}, ${outputTokens}, ${cacheReadTokens}, ${cacheWriteTokens}, ${reasoningTokens}
    );`;
  });
  const result = spawnSync(sqlite3, [stateDbPath], {
    input: [schema, ...inserts].join("\n"),
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to write Hermes state.db for tests: ${result.error?.message || result.stderr || result.status}`);
  }
  return stateDbPath;
}
