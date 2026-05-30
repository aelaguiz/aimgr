import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTHORITY_STATE_REMOTE_PATH } from "../core/constants.js";
import { loadAimgrState, loadAimgrStateFromJsonValue } from "../state/schema.js";

export function shellQuoteSingle(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

export function escapeDoubleQuotedShellFragment(value) {
  return String(value ?? "").replace(/(["\\`$])/g, "\\$1");
}

export function normalizeRemoteAuthorityPath(rawPath) {
  const input = String(rawPath ?? "").trim();
  if (!input) {
    throw new Error("Authority ssh locator is missing a remote state path.");
  }
  if (input === "~") return "$HOME";
  if (input.startsWith("/~/")) return `$HOME/${input.slice(3)}`;
  if (input.startsWith("~/")) return `$HOME/${input.slice(2)}`;
  return input;
}

export function buildRemoteCatCommand(remotePath) {
  if (remotePath === "$HOME") {
    return 'cat -- "$HOME"';
  }
  if (remotePath.startsWith("$HOME/")) {
    return `cat -- "$HOME/${escapeDoubleQuotedShellFragment(remotePath.slice("$HOME/".length))}"`;
  }
  return `cat -- ${shellQuoteSingle(remotePath)}`;
}

export function buildRemoteStateArg(remotePath) {
  if (!remotePath || remotePath === DEFAULT_AUTHORITY_STATE_REMOTE_PATH) {
    return "";
  }
  if (remotePath === "$HOME") {
    return '--state "$HOME"';
  }
  if (remotePath.startsWith("$HOME/")) {
    return `--state "$HOME/${escapeDoubleQuotedShellFragment(remotePath.slice("$HOME/".length))}"`;
  }
  return `--state ${shellQuoteSingle(remotePath)}`;
}

export function resolveAuthorityLocator(locator) {
  const raw = String(locator ?? "").trim();
  if (!raw) {
    throw new Error("Missing legacy authority locator. Authority files are read-only migration input after the Redis cutover.");
  }

  if (raw.startsWith("ssh://")) {
    const parsed = new URL(raw);
    if (!parsed.hostname) {
      throw new Error(`Invalid ssh authority locator: ${raw}`);
    }
    const remotePath =
      parsed.pathname && parsed.pathname !== "/"
        ? normalizeRemoteAuthorityPath(decodeURIComponent(parsed.pathname))
        : DEFAULT_AUTHORITY_STATE_REMOTE_PATH;
    return {
      kind: "ssh",
      target: parsed.username ? `${parsed.username}@${parsed.hostname}` : parsed.hostname,
      port: parsed.port ? String(parsed.port) : null,
      remotePath,
      display: raw,
    };
  }

  const bareSshTarget = raw.match(/^[^/:\s]+@[^/:\s]+$/);
  if (bareSshTarget) {
    return {
      kind: "ssh",
      target: raw,
      port: null,
      remotePath: DEFAULT_AUTHORITY_STATE_REMOTE_PATH,
      display: raw,
    };
  }

  const scpLike = raw.match(/^([^/:\s]+(?:@[^/:\s]+)?):(.+)$/);
  if (scpLike) {
    return {
      kind: "ssh",
      target: scpLike[1],
      port: null,
      remotePath: normalizeRemoteAuthorityPath(scpLike[2]),
      display: raw,
    };
  }

  return {
    kind: "file",
    path: path.resolve(raw),
    display: path.resolve(raw),
  };
}

export function buildAuthorityLocatorKey(locator) {
  const resolved = typeof locator === "string" ? resolveAuthorityLocator(locator) : locator;
  if (resolved.kind === "ssh") {
    return `ssh:${resolved.target}:${resolved.port || ""}:${resolved.remotePath}`;
  }
  return `file:${resolved.path}`;
}

export function authorityLocatorsMatch(a, b) {
  try {
    return buildAuthorityLocatorKey(a) === buildAuthorityLocatorKey(b);
  } catch {
    return String(a ?? "").trim() === String(b ?? "").trim();
  }
}

export function loadAuthorityState(locator) {
  const source = resolveAuthorityLocator(locator);
  if (source.kind === "file") {
    if (!fs.existsSync(source.path)) {
      throw new Error(`Authority AIM state file not found: ${source.path}`);
    }
    return { source, state: loadAimgrState(source.path) };
  }

  const args = [];
  if (source.port) {
    args.push("-p", source.port);
  }
  args.push(source.target, buildRemoteCatCommand(source.remotePath));
  const result = spawnSync("ssh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Failed to read authority AIM state via ssh (${source.display}): ${String(result.error?.message ?? result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `ssh authority read failed for ${source.display} (exit ${result.status}). ` +
        `${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch (err) {
    throw new Error(`Authority AIM state is not valid JSON (${source.display}): ${String(err?.message ?? err)}`);
  }
  return { source, state: loadAimgrStateFromJsonValue(parsed, source.display) };
}
