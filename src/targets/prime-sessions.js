import fs from "node:fs";
import path from "node:path";
import { HARNESS_MANAGED_PROVIDERS } from "./harness-auth.js";
import {
  expandHomeShorthandPath,
  resolveManagedPrimeAgentDir,
} from "../io/paths.js";

export function resolvePrimeSessionDir({ homeDir, env = {} }) {
  const sessionDirOverride = String(
    env.PRIME_AGENT_SESSION_DIR ?? env.PRIME_AGENT_CODING_AGENT_SESSION_DIR ?? "",
  ).trim();
  return sessionDirOverride
    ? path.resolve(expandHomeShorthandPath(sessionDirOverride, { homeDir }))
    : path.join(resolveManagedPrimeAgentDir({ homeDir, env }), "sessions");
}

export function resolvePrimeSessionPath({ selector, homeDir, env = {}, cwd = process.cwd() }) {
  const value = String(selector ?? "").trim();
  if (!value) throw new Error("Missing Prime session selector.");
  const looksLikePath = value.includes("/") || value.includes("\\") || value.endsWith(".jsonl");
  if (looksLikePath) {
    const candidate = path.resolve(cwd, expandHomeShorthandPath(value, { homeDir }));
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(`Prime session file does not exist: ${candidate}`);
    }
    return candidate;
  }

  const sessionDir = resolvePrimeSessionDir({ homeDir, env });
  const exactPath = path.join(sessionDir, `${value}.jsonl`);
  if (fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()) return exactPath;

  let names;
  try {
    names = fs.readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name);
  } catch {
    throw new Error(`Prime session directory is unavailable: ${sessionDir}`);
  }
  const normalizedSelector = value.replaceAll("-", "").toLowerCase();
  const hexSelector = normalizedSelector && /^[0-9a-f]+$/.test(normalizedSelector);
  const matches = names.filter((name) => {
    const id = name.slice(0, -".jsonl".length);
    const normalizedId = id.replaceAll("-", "").toLowerCase();
    return hexSelector && /^[0-9a-f]+$/.test(normalizedId)
      ? normalizedId.startsWith(normalizedSelector) || normalizedId.endsWith(normalizedSelector)
      : id.startsWith(value);
  });
  if (matches.length === 1) return path.join(sessionDir, matches[0]);
  if (matches.length > 1) throw new Error(`Ambiguous Prime session selector: ${value}`);
  throw new Error(`No Prime session found matching: ${value}`);
}

export function readPrimeSessionEntries(sessionPath) {
  const entries = [];
  for (const line of fs.readFileSync(sessionPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Ignore a concurrently appended partial tail; it cannot be the active leaf.
    }
  }
  return entries;
}

export function readPrimeActiveBranch(sessionPath) {
  const entries = readPrimeSessionEntries(sessionPath);
  const byId = new Map(entries
    .filter((entry) => entry?.type !== "session" && typeof entry?.id === "string")
    .map((entry) => [entry.id, entry]));
  const activeBranch = [];
  const seenEntryIds = new Set();
  let entry = [...entries].reverse().find((candidate) => (
    candidate?.type !== "session" && typeof candidate?.id === "string"
  ));
  while (entry) {
    if (seenEntryIds.has(entry.id)) {
      throw new Error(`Prime session has a cyclic active branch: ${sessionPath}`);
    }
    seenEntryIds.add(entry.id);
    activeBranch.push(entry);
    entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : null;
  }
  activeBranch.reverse();
  return { entries, activeBranch };
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return null;
  const parts = message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
  return parts.length ? parts.join("") : null;
}

export function readLatestPrimeUserText(sessionPath) {
  const { activeBranch } = readPrimeActiveBranch(sessionPath);
  for (let index = activeBranch.length - 1; index >= 0; index -= 1) {
    const entry = activeBranch[index];
    if (entry?.type === "message" && entry.message?.role === "user") {
      return messageText(entry.message);
    }
  }
  return null;
}

export function readPrimeLatestTurn(sessionPath) {
  const { activeBranch } = readPrimeActiveBranch(sessionPath);
  let userIndex = -1;
  for (let index = activeBranch.length - 1; index >= 0; index -= 1) {
    const entry = activeBranch[index];
    if (entry?.type === "message" && entry.message?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex === -1) return { userText: null, assistant: null };
  let assistant = null;
  for (let index = userIndex + 1; index < activeBranch.length; index += 1) {
    const entry = activeBranch[index];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const stopReason = typeof entry.message.stopReason === "string"
      ? entry.message.stopReason
      : null;
    assistant = {
      text: messageText(entry.message),
      stopReason,
      provider: typeof entry.message.provider === "string" ? entry.message.provider : null,
      model: typeof entry.message.model === "string" ? entry.message.model : null,
    };
  }
  return {
    userText: messageText(activeBranch[userIndex].message),
    assistant,
  };
}

export function readPrimeSessionProfile({
  selector,
  homeDir,
  env = {},
  cwd = process.cwd(),
  requireThinking = false,
}) {
  const sessionPath = resolvePrimeSessionPath({ selector, homeDir, env, cwd });
  const { entries, activeBranch } = readPrimeActiveBranch(sessionPath);
  const sessionHeader = entries.find((candidate) => (
    candidate?.type === "session" && typeof candidate.id === "string"
  ));
  if (!sessionHeader?.id) throw new Error(`Prime session has no session ID: ${sessionPath}`);

  let lastModel = null;
  let thinking = null;
  const bindings = new Map();
  const bindingHistoryByProvider = new Map();
  for (const entry of activeBranch) {
    if (
      entry?.type === "model_change"
      && typeof entry.provider === "string"
      && typeof entry.modelId === "string"
    ) {
      lastModel = { provider: entry.provider, model: entry.modelId };
    }
    if (
      entry?.type === "message"
      && entry.message?.role === "assistant"
      && typeof entry.message.provider === "string"
      && typeof entry.message.model === "string"
    ) {
      lastModel = { provider: entry.message.provider, model: entry.message.model };
    }
    if (entry?.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      thinking = entry.thinkingLevel;
    }
    const credentialBinding = entry?.type === "credential_binding"
      ? entry
      : entry?.type === "custom" && entry.customType === "aimgr_credential_binding_v1"
        ? entry.data
        : null;
    if (
      credentialBinding?.source === "aimgr"
      && typeof credentialBinding.provider === "string"
      && typeof credentialBinding.binding === "string"
    ) {
      const bindingHistory = bindingHistoryByProvider.get(credentialBinding.provider) ?? [];
      bindingHistory.push(credentialBinding.binding);
      bindingHistoryByProvider.set(credentialBinding.provider, bindingHistory);
      bindings.set(credentialBinding.provider, {
        binding: credentialBinding.binding,
        identityFingerprint: typeof credentialBinding.identityFingerprint === "string"
          ? credentialBinding.identityFingerprint
          : null,
      });
    }
  }
  if (!lastModel) throw new Error(`Prime session has no model metadata: ${sessionPath}`);
  if (!HARNESS_MANAGED_PROVIDERS.includes(lastModel.provider)) {
    throw new Error(`AIM cannot use unsupported Prime provider=${lastModel.provider}.`);
  }
  const binding = bindings.get(lastModel.provider);
  if (!binding) {
    throw new Error(`Prime session has no AIM binding for provider=${lastModel.provider}.`);
  }
  if (!binding.binding || !binding.identityFingerprint) {
    throw new Error(`Prime session has an incomplete AIM binding for provider=${lastModel.provider}.`);
  }
  if (requireThinking && !thinking) {
    throw new Error(`Prime session has no thinking metadata: ${sessionPath}`);
  }
  return {
    ...lastModel,
    ...binding,
    bindingHistory: bindingHistoryByProvider.get(lastModel.provider) ?? [],
    thinking,
    sessionId: sessionHeader.id,
    sessionPath,
    cwd: typeof sessionHeader.cwd === "string" ? sessionHeader.cwd : null,
  };
}
