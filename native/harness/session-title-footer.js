// Managed by aimgr. Local edits are replaced by `aim pi use` / `aim prime use`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const IDENTITY_STATE_TYPE = "aimgr.session-identity";
export const IDENTITY_STATE_VERSION = 1;
export const WIDGET_KEY = "session-identity";
const AIM_CREDENTIAL_BINDING_TYPE = "aimgr_credential_binding_v1";

export const SESSION_COLORS = Object.freeze([
  Object.freeze({ name: "red", ansi: 124 }),
  Object.freeze({ name: "orange", ansi: 166 }),
  Object.freeze({ name: "gold", ansi: 136 }),
  Object.freeze({ name: "green", ansi: 28 }),
  Object.freeze({ name: "teal", ansi: 30 }),
  Object.freeze({ name: "cyan", ansi: 24 }),
  Object.freeze({ name: "blue", ansi: 25 }),
  Object.freeze({ name: "purple", ansi: 55 }),
  Object.freeze({ name: "magenta", ansi: 89 }),
  Object.freeze({ name: "rose", ansi: 125 }),
]);

const COLOR_BY_NAME = new Map(SESSION_COLORS.map((color) => [color.name, color]));
const MAX_TITLE_WORDS = 10;
const MAX_TITLE_CHARS = 68;
const WAITING_TITLE = "waiting for first prompt";

function singleLine(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedTitle(value) {
  let title = singleLine(value)
    .replace(/^(?:[-*#>]+\s*)+/, "")
    .replace(/^\/(?:[a-z][\w:-]*)(?:\s+|$)/i, "")
    .replace(/^(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, "")
    .replace(/^(?:can|could|would)\s+we\s+(?:just\s+)?/i, "")
    .replace(/^i(?:'d| would)\s+like\s+(?:you\s+)?to\s+/i, "")
    .replace(/^i\s+(?:want|need)\s+(?:you\s+)?to\s+/i, "")
    .replace(/^please\s+/i, "")
    .trim();
  title = title.split(/(?<=[.!?])\s|\n/)[0]?.replace(/[.!?]+$/, "").trim() ?? "";
  if (!title) return undefined;
  const words = title.split(/\s+/).slice(0, MAX_TITLE_WORDS);
  title = words.join(" ");
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).replace(/\s+\S*$/, "").trim();
  }
  if (!title) return undefined;
  return `${title[0].toUpperCase()}${title.slice(1)}`;
}

export function titleFromPrompt(text) {
  return boundedTitle(text);
}

export function titleFromRecap(text) {
  return boundedTitle(text);
}

function titleWithSessionSuffix(title, ctx) {
  const getSessionId = ctx.sessionManager?.getSessionId;
  if (typeof getSessionId !== "function") return undefined;
  const suffixId = singleLine(getSessionId.call(ctx.sessionManager))
    .replace(/[^a-z0-9]/gi, "")
    .slice(-6);
  if (!suffixId) return undefined;
  const suffix = ` · ${suffixId}`;
  const maxBaseLength = MAX_TITLE_CHARS - suffix.length;
  const base = singleLine(title)
    .slice(0, maxBaseLength)
    .replace(/\s+\S*$/, "")
    .trim();
  return base ? `${base}${suffix}` : undefined;
}

export function pickSessionColor(random = Math.random) {
  const sample = Number(random());
  const index = Number.isFinite(sample)
    ? Math.min(SESSION_COLORS.length - 1, Math.max(0, Math.floor(sample * SESSION_COLORS.length)))
    : 0;
  return SESSION_COLORS[index].name;
}

export function readIdentityState(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== IDENTITY_STATE_TYPE) continue;
    const data = entry.data;
    if (
      !data ||
      typeof data !== "object" ||
      data.version !== IDENTITY_STATE_VERSION ||
      !COLOR_BY_NAME.has(data.color)
    ) {
      continue;
    }
    return {
      version: IDENTITY_STATE_VERSION,
      color: data.color,
      ...(typeof data.autoTitle === "string" && data.autoTitle.trim()
        ? { autoTitle: data.autoTitle.trim() }
        : {}),
      ...(data.titleSource === "prompt" || data.titleSource === "recap"
        ? { titleSource: data.titleSource }
        : {}),
      ...(Number.isInteger(data.recapMessageCount) && data.recapMessageCount >= 0
        ? { recapMessageCount: data.recapMessageCount }
        : {}),
    };
  }
  return undefined;
}

function textBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

export function firstUserPrompt(entries) {
  for (const entry of entries) {
    if (entry?.type === "message" && entry.message?.role === "user") {
      const text = singleLine(textBlocks(entry.message.content));
      if (text) return text;
    }
  }
  return undefined;
}

export function latestAgentRecap(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const summary = entry?.type === "agent_status" ? singleLine(entry.status?.summary) : "";
    if (!summary) continue;
    return {
      summary,
      basedOnMessageCount: Number.isInteger(entry.status?.basedOnMessageCount)
        ? entry.status.basedOnMessageCount
        : 0,
    };
  }
  return undefined;
}

export function renderIdentityLine({ title, color, account, branch, cwd }) {
  const ansi = COLOR_BY_NAME.get(color)?.ansi ?? COLOR_BY_NAME.get("blue").ansi;
  const safeTitle = singleLine(title) || WAITING_TITLE;
  const safeAccount = singleLine(account) || "unbound";
  const safeBranch = singleLine(branch) || "no-branch";
  const safeCwd = singleLine(cwd) || "?";
  return [
    `\u001b[1;97;48;5;${ansi}m title:${safeTitle} \u001b[0m`,
    `\u001b[2m · account:${safeAccount} · branch:${safeBranch} · cwd:${safeCwd}\u001b[0m`,
  ].join("");
}

export function renderSessionIdLine(sessionId) {
  const safeSessionId = singleLine(sessionId);
  return safeSessionId ? `\u001b[2m session-id: ${safeSessionId}\u001b[0m` : undefined;
}

function installedAgentDir() {
  const extensionPath = fileURLToPath(import.meta.url);
  return dirname(dirname(extensionPath));
}

function configuredBindings(agentDir = installedAgentDir()) {
  const bindings = new Map();
  try {
    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return bindings;
    for (const [provider, entry] of Object.entries(auth)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (
        entry.type === "external" &&
        entry.source === "aimgr" &&
        typeof entry.binding === "string"
      ) {
        bindings.set(provider, entry.binding);
      } else if (entry.type === "oauth") {
        const accountId = typeof entry.accountId === "string" ? entry.accountId : "";
        bindings.set(provider, accountId ? `oauth:${accountId.slice(0, 8)}` : "oauth");
      }
    }
  } catch {
    // The identity banner remains useful while auth is absent or unreadable.
  }
  return bindings;
}

function sessionBindings(ctx) {
  const persisted = new Map();
  try {
    for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
      const data = entry?.type === "custom" && entry.customType === AIM_CREDENTIAL_BINDING_TYPE
        ? entry.data
        : undefined;
      if (
        data?.source === "aimgr" &&
        typeof data.provider === "string" &&
        typeof data.binding === "string"
      ) {
        persisted.set(data.provider, data);
      }
    }
  } catch {
    // Fall through to a host-provided binding snapshot when entries are unavailable.
  }
  if (persisted.size > 0) return persisted;

  const getBindings = ctx.sessionManager?.getCredentialBindings;
  if (typeof getBindings !== "function") return new Map();
  try {
    return getBindings.call(ctx.sessionManager);
  } catch {
    return new Map();
  }
}

function gitBranch(cwd) {
  try {
    return (
      execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "detached"
    );
  } catch {
    return "no-branch";
  }
}

function compactHome(cwd) {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function currentSessionName(pi, ctx) {
  try {
    if (typeof pi.getSessionName === "function") return singleLine(pi.getSessionName());
  } catch {
    // Fall through to the read-only session view.
  }
  try {
    return singleLine(ctx.sessionManager?.getSessionName?.());
  } catch {
    return "";
  }
}

function currentSessionId(ctx) {
  const getSessionId = ctx.sessionManager?.getSessionId;
  if (typeof getSessionId !== "function") return undefined;
  try {
    return getSessionId.call(ctx.sessionManager);
  } catch {
    return undefined;
  }
}

function resolveAccount(ctx, configured) {
  const persisted = sessionBindings(ctx);
  const provider = ctx.model?.provider;
  return (
    (provider ? persisted.get(provider)?.binding : undefined) ||
    (provider ? configured.get(provider) : undefined) ||
    persisted.get("openai-codex")?.binding ||
    persisted.get("anthropic")?.binding ||
    configured.get("openai-codex") ||
    configured.get("anthropic") ||
    "unbound"
  );
}

export default function sessionIdentityExtension(pi) {
  let configured = new Map();
  let identity;
  let identityPersisted = false;
  let branch = "no-branch";
  let manualTitle = false;
  let lastRenderedWidget;
  let lastTerminalTitle;
  let refreshTimer;
  let titleUpdate = Promise.resolve();

  const appendIdentity = () => {
    if (!identity) return false;
    try {
      pi.appendEntry(IDENTITY_STATE_TYPE, identity);
      identityPersisted = true;
      return true;
    } catch {
      return false;
    }
  };

  const isHumanOwnedTitle = (ctx) => {
    const current = currentSessionName(pi, ctx);
    if (!current) return false;
    if (!identity?.autoTitle || current !== identity.autoTitle) return true;
    const entries = ctx.sessionManager.getEntries();
    let latestIdentityIndex = -1;
    let latestMatchingNameIndex = -1;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (
        entry?.type === "custom" &&
        entry.customType === IDENTITY_STATE_TYPE &&
        readIdentityState([entry])
      ) {
        latestIdentityIndex = index;
      }
      if (entry?.type === "session_info" && singleLine(entry.name) === current) {
        latestMatchingNameIndex = index;
      }
    }
    return latestMatchingNameIndex > latestIdentityIndex;
  };

  const update = (ctx, refreshBranch = false, force = false) => {
    if (refreshBranch) branch = gitBranch(ctx.cwd);
    const current = currentSessionName(pi, ctx);
    if (!manualTitle && isHumanOwnedTitle(ctx)) manualTitle = true;
    if (
      !identityPersisted &&
      (current || ctx.sessionManager.getEntries().some((entry) => entry?.type === "message"))
    ) {
      appendIdentity();
    }
    const title = current || WAITING_TITLE;
    const line = renderIdentityLine({
      title,
      color: identity?.color ?? "blue",
      account: resolveAccount(ctx, configured),
      branch,
      cwd: compactHome(ctx.cwd),
    });
    const sessionIdLine = renderSessionIdLine(currentSessionId(ctx));
    const lines = sessionIdLine ? [line, sessionIdLine] : [line];
    const renderedWidget = lines.join("\n");
    if (force || renderedWidget !== lastRenderedWidget) {
      lastRenderedWidget = renderedWidget;
      ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
    }
    const terminalTitle = `${title} — ${basename(ctx.cwd)}`;
    if (force || terminalTitle !== lastTerminalTitle) {
      lastTerminalTitle = terminalTitle;
      ctx.ui.setTitle(terminalTitle);
    }
  };

  const applyAutoTitle = async (ctx, title, titleSource, recapMessageCount = 0) => {
    const bounded = titleSource === "recap" ? titleFromRecap(title) : titleFromPrompt(title);
    if (!bounded || manualTitle) return false;
    if (isHumanOwnedTitle(ctx)) {
      manualTitle = true;
      return false;
    }
    let appliedTitle = bounded;
    try {
      await pi.setSessionName(appliedTitle);
    } catch {
      const uniqueTitle = titleWithSessionSuffix(bounded, ctx);
      if (!uniqueTitle || uniqueTitle === bounded) return false;
      try {
        await pi.setSessionName(uniqueTitle);
        appliedTitle = uniqueTitle;
      } catch {
        return false;
      }
    }
    identity = {
      ...identity,
      version: IDENTITY_STATE_VERSION,
      autoTitle: appliedTitle,
      titleSource,
      ...(titleSource === "recap" ? { recapMessageCount } : {}),
    };
    appendIdentity();
    update(ctx);
    return true;
  };

  const queueAutoTitle = (ctx, title, titleSource, recapMessageCount = 0) => {
    titleUpdate = titleUpdate
      .catch(() => undefined)
      .then(() => applyAutoTitle(ctx, title, titleSource, recapMessageCount));
    return titleUpdate;
  };

  const maybeUpgradeFromRecap = async (ctx) => {
    if (!identity || manualTitle) return;
    if (isHumanOwnedTitle(ctx)) {
      manualTitle = true;
      return;
    }
    const entries = ctx.sessionManager.getEntries();
    const current = currentSessionName(pi, ctx);
    if (!current && identity.autoTitle) {
      await queueAutoTitle(
        ctx,
        identity.autoTitle,
        identity.titleSource ?? "prompt",
        identity.recapMessageCount ?? 0,
      );
      return;
    }
    const recap = latestAgentRecap(entries);
    if (!identity.autoTitle) {
      if (recap) {
        await queueAutoTitle(ctx, recap.summary, "recap", recap.basedOnMessageCount);
      } else {
        const prompt = firstUserPrompt(entries);
        if (prompt) await queueAutoTitle(ctx, prompt, "prompt");
      }
      return;
    }
    if (identity.titleSource !== "prompt") return;
    if (!recap || recap.basedOnMessageCount <= (identity.recapMessageCount ?? 0)) return;
    await queueAutoTitle(ctx, recap.summary, "recap", recap.basedOnMessageCount);
  };

  pi.on("session_start", async (_event, ctx) => {
    if (refreshTimer) clearInterval(refreshTimer);
    configured = configuredBindings();
    branch = gitBranch(ctx.cwd);
    lastRenderedWidget = undefined;
    lastTerminalTitle = undefined;
    manualTitle = false;

    const entries = ctx.sessionManager.getEntries();
    identity = readIdentityState(entries);
    identityPersisted = Boolean(identity);
    if (!identity) {
      identity = { version: IDENTITY_STATE_VERSION, color: pickSessionColor() };
    }

    const current = currentSessionName(pi, ctx);
    if (current) {
      manualTitle = isHumanOwnedTitle(ctx);
    } else if (identity.autoTitle) {
      await queueAutoTitle(
        ctx,
        identity.autoTitle,
        identity.titleSource ?? "prompt",
        identity.recapMessageCount ?? 0,
      );
    } else {
      const recap = latestAgentRecap(entries);
      if (recap) {
        await queueAutoTitle(ctx, recap.summary, "recap", recap.basedOnMessageCount);
      } else {
        const prompt = firstUserPrompt(entries);
        if (prompt) await queueAutoTitle(ctx, prompt, "prompt");
      }
    }

    update(ctx);
    refreshTimer = setInterval(() => {
      void maybeUpgradeFromRecap(ctx);
      // Daemon extension UI is fire-and-forget rather than replayed state. Re-send
      // unchanged identity so a newly attached client receives the banner/title.
      update(ctx, false, true);
    }, 1000);
    refreshTimer.unref?.();
  });

  pi.on("input", async (event, ctx) => {
    const input = String(event.text ?? "");
    const explicitNameCommand = /^\s*\/(?:name|rename)(?:\s|$)/i.test(input);
    if (
      event.source !== "extension" &&
      !explicitNameCommand &&
      !manualTitle &&
      !currentSessionName(pi, ctx)
    ) {
      await queueAutoTitle(ctx, input, "prompt");
    }
    return { action: "continue" };
  });

  pi.on("agent_start", async (_event, ctx) => update(ctx, true));
  pi.on("agent_end", async (_event, ctx) => {
    await maybeUpgradeFromRecap(ctx);
    update(ctx, true);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    lastRenderedWidget = undefined;
    lastTerminalTitle = undefined;
    ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
  });

}
