import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENTS_REPO_ROOT } from "../core/constants.js";

export function resolveExecutableOnPath(commandName, { extraSearchPaths = [] } = {}) {
  const normalized = String(commandName ?? "").trim();
  if (!normalized) return null;
  const searchDirs = [
    ...extraSearchPaths,
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean),
  ];
  const seen = new Set();
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, normalized);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveSqlite3Command({ homeDir, spawnImpl = spawnSync } = {}) {
  if (spawnImpl !== spawnSync) {
    return "sqlite3";
  }
  const effectiveHomeDir = String(homeDir ?? process.env.HOME ?? "").trim();
  const extraSearchPaths = [
    effectiveHomeDir ? path.join(effectiveHomeDir, "Library", "Android", "sdk", "platform-tools") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ].filter(Boolean);
  return resolveExecutableOnPath("sqlite3", { extraSearchPaths }) || "sqlite3";
}

export function resolveAgentBrowserCommand({ spawnImpl = spawnSync } = {}) {
  if (spawnImpl !== spawnSync) {
    return "agent-browser";
  }
  return resolveExecutableOnPath("agent-browser", {
    extraSearchPaths: [
      path.resolve(DEFAULT_AGENTS_REPO_ROOT, "..", "bin"),
      path.resolve(DEFAULT_AGENTS_REPO_ROOT, "..", "tools", "agent-browser", "node_modules", ".bin"),
    ],
  }) || "agent-browser";
}

export function activateAgentBrowserApp({ spawnImpl = spawnSync } = {}) {
  if (spawnImpl !== spawnSync) {
    return { ok: true };
  }
  if (process.platform !== "darwin") {
    return { ok: true };
  }
  const result = spawnImpl(
    "osascript",
    ["-e", 'tell application "Google Chrome for Testing" to activate'],
    { stdio: "ignore" },
  );
  if (result?.error) {
    return { ok: false, reason: "activate_error", error: String(result.error?.message ?? result.error) };
  }
  if (result?.status !== 0) {
    return { ok: false, reason: "activate_nonzero", status: result.status };
  }
  return { ok: true };
}

export function spawnQuiet(cmd, cmdArgs, options) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, cmdArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      ...options,
    });

    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      if (stderr.length > 10_000) {
        stderr = stderr.slice(stderr.length - 10_000);
      }
    });

    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stderr: stderr.trim() });
    });
  });
}

export function probeOpenclawGateway({ timeoutMs }) {
  const params = JSON.stringify({ limit: 1 });
  const result = spawnSync(
    "openclaw",
    ["gateway", "call", "sessions.list", "--params", params, "--json", "--timeout", String(timeoutMs)],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  );

  if (result.error) {
    return { ok: false, reason: "spawn_error", error: String(result.error?.message ?? result.error) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: "nonzero_exit",
      status: result.status,
      stderr: String(result.stderr ?? "").trim(),
    };
  }

  return { ok: true };
}

export function restartOpenclawGateway({ timeoutMs }) {
  const result = spawnSync(
    "openclaw",
    ["gateway", "restart"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    },
  );

  if (result.error) {
    return { ok: false, reason: "spawn_error", error: String(result.error?.message ?? result.error) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: "nonzero_exit",
      status: result.status,
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
    };
  }

  return {
    ok: true,
    status: "restarted",
    stdout: String(result.stdout ?? "").trim(),
  };
}

export async function applySessionsModelViaGatewayOps({ ops, timeoutMs }) {
  const failures = [];
  const concurrency = 6;
  let idx = 0;

  const worker = async () => {
    while (true) {
      const nextIndex = idx;
      idx += 1;
      if (nextIndex >= ops.length) return;

      const op = ops[nextIndex];
      const params = JSON.stringify({ key: op.key, model: op.modelRef });
      const call = await spawnQuiet(
        "openclaw",
        ["gateway", "call", "sessions.patch", "--params", params, "--json", "--timeout", String(timeoutMs)],
        {},
      );
      if (call.code !== 0) {
        failures.push({ key: op.key, error: call.stderr || `exit ${call.code}` });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, ops.length) }, () => worker()));
  return { ok: failures.length === 0, failures };
}

export async function applySessionsModelViaGateway({ keys, modelRef, timeoutMs }) {
  const ops = (Array.isArray(keys) ? keys : []).map((key) => ({ key, modelRef }));
  return await applySessionsModelViaGatewayOps({ ops, timeoutMs });
}
