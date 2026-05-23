import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { clampPercent } from "../core/numbers.js";
import { isObject } from "../core/normalize.js";
import { fetchJsonWithTimeout } from "../io/fetch.js";
import { ensureStateShape } from "../state/schema.js";

export async function fetchCodexUsageSnapshot({
  accessToken,
  accountId,
  timeoutMs,
  fetchJsonWithTimeoutImpl = fetchJsonWithTimeout,
}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "CodexBar",
    Accept: "application/json",
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  };

  const res = await fetchJsonWithTimeoutImpl(
    "https://chatgpt.com/backend-api/wham/usage",
    { method: "GET", headers },
    timeoutMs,
  );

  if (!res.ok) {
    let error;
    let rateLimitMetadata = {};
    try {
      const data = await res.json();
      rateLimitMetadata = extractCodexRateLimitMetadata(data);
      const rawError = data?.error?.message ?? data?.message ?? data?.detail;
      if (typeof rawError === "string" && rawError.trim()) {
        error = rawError.trim();
      }
    } catch {
      // ignore parse errors
    }
    return {
      provider: OPENAI_CODEX_PROVIDER,
      ok: false,
      status: res.status,
      tokenExpired: res.status === 401 || res.status === 403,
      ...(error ? { error } : {}),
      ...rateLimitMetadata,
    };
  }

  const data = await res.json();
  const rateLimitMetadata = extractCodexRateLimitMetadata(data);
  const windows = [];

  const primary = data?.rate_limit?.primary_window;
  if (primary) {
    const windowHours = Math.round(((primary.limit_window_seconds || 10800) * 1.0) / 3600);
    windows.push({
      label: `${windowHours}h`,
      usedPercent: clampPercent(primary.used_percent || 0),
      resetAt: primary.reset_at ? primary.reset_at * 1000 : undefined,
    });
  }

  const secondary = data?.rate_limit?.secondary_window;
  if (secondary) {
    const windowHours = Math.round(((secondary.limit_window_seconds || 86400) * 1.0) / 3600);
    const label = windowHours >= 168 ? "Week" : windowHours >= 24 ? "Day" : `${windowHours}h`;
    windows.push({
      label,
      usedPercent: clampPercent(secondary.used_percent || 0),
      resetAt: secondary.reset_at ? secondary.reset_at * 1000 : undefined,
    });
  }

  let plan = data?.plan_type;
  const balanceRaw = data?.credits?.balance;
  if (balanceRaw !== undefined && balanceRaw !== null) {
    const balance = typeof balanceRaw === "number" ? balanceRaw : parseFloat(balanceRaw) || 0;
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }

  return {
    provider: OPENAI_CODEX_PROVIDER,
    ok: true,
    windows,
    plan,
    ...rateLimitMetadata,
  };
}

export function extractCodexRateLimitMetadata(data) {
  const metadata = {};
  const rateLimit = isObject(data?.rate_limit) ? data.rate_limit : {};
  const allowed =
    typeof data?.allowed === "boolean"
      ? data.allowed
      : typeof rateLimit.allowed === "boolean"
        ? rateLimit.allowed
        : undefined;
  const limitReached =
    typeof data?.limit_reached === "boolean"
      ? data.limit_reached
      : typeof rateLimit.limit_reached === "boolean"
        ? rateLimit.limit_reached
        : undefined;
  const rateLimitReachedTypeRaw =
    typeof data?.rate_limit_reached_type === "string"
      ? data.rate_limit_reached_type
      : typeof rateLimit.rate_limit_reached_type === "string"
        ? rateLimit.rate_limit_reached_type
        : "";
  const rateLimitReachedType = rateLimitReachedTypeRaw.trim();

  if (allowed !== undefined) {
    metadata.allowed = allowed;
  }
  if (limitReached !== undefined) {
    metadata.limitReached = limitReached;
  }
  if (rateLimitReachedType) {
    metadata.rateLimitReachedType = rateLimitReachedType;
  }
  return metadata;
}

export function buildClaudeUsageWindows(data) {
  const windows = [];

  if (data?.five_hour?.utilization !== undefined) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(data.five_hour.utilization),
      resetAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at).getTime() : undefined,
    });
  }

  if (data?.seven_day?.utilization !== undefined) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(data.seven_day.utilization),
      resetAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at).getTime() : undefined,
    });
  }

  if (data?.seven_day_sonnet?.utilization !== undefined) {
    windows.push({
      label: "Sonnet",
      usedPercent: clampPercent(data.seven_day_sonnet.utilization),
      resetAt: data.seven_day_sonnet.resets_at ? new Date(data.seven_day_sonnet.resets_at).getTime() : undefined,
    });
  }

  if (data?.seven_day_opus?.utilization !== undefined) {
    windows.push({
      label: "Opus",
      usedPercent: clampPercent(data.seven_day_opus.utilization),
      resetAt: data.seven_day_opus.resets_at ? new Date(data.seven_day_opus.resets_at).getTime() : undefined,
    });
  }

  return windows;
}

export function resolveClaudeWebSessionKey({ env = {} } = {}) {
  const direct = env.CLAUDE_AI_SESSION_KEY?.trim() ?? env.CLAUDE_WEB_SESSION_KEY?.trim();
  if (direct?.startsWith("sk-ant-")) {
    return direct;
  }

  const cookieHeader = env.CLAUDE_WEB_COOKIE?.trim();
  if (!cookieHeader) {
    return undefined;
  }
  const stripped = cookieHeader.replace(/^cookie:\s*/i, "");
  const match = stripped.match(/(?:^|;\s*)sessionKey=([^;\s]+)/i);
  const value = match?.[1]?.trim();
  return value?.startsWith("sk-ant-") ? value : undefined;
}

export async function fetchClaudeWebUsage({
  sessionKey,
  timeoutMs,
  fetchJsonWithTimeoutImpl = fetchJsonWithTimeout,
}) {
  const headers = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
  };

  const orgRes = await fetchJsonWithTimeoutImpl(
    "https://claude.ai/api/organizations",
    { method: "GET", headers },
    timeoutMs,
  );
  if (!orgRes.ok) {
    return null;
  }

  const orgs = await orgRes.json();
  const orgId = typeof orgs?.[0]?.uuid === "string" ? orgs[0].uuid.trim() : "";
  if (!orgId) {
    return null;
  }

  const usageRes = await fetchJsonWithTimeoutImpl(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { method: "GET", headers },
    timeoutMs,
  );
  if (!usageRes.ok) {
    return null;
  }

  const data = await usageRes.json();
  const windows = buildClaudeUsageWindows(data);
  if (windows.length === 0) {
    return null;
  }

  return {
    provider: ANTHROPIC_PROVIDER,
    ok: true,
    windows,
  };
}

export async function fetchClaudeUsageSnapshot({
  accessToken,
  timeoutMs,
  env = {},
  fetchJsonWithTimeoutImpl = fetchJsonWithTimeout,
}) {
  const res = await fetchJsonWithTimeoutImpl(
    "https://api.anthropic.com/api/oauth/usage",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "aimgr",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    timeoutMs,
  );

  if (!res.ok) {
    let message;
    try {
      const data = await res.json();
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) {
        message = raw.trim();
      }
    } catch {
      // ignore parse errors
    }

    const missingScope = res.status === 403 && message?.includes("scope requirement user:profile");
    if (missingScope) {
      const sessionKey = resolveClaudeWebSessionKey({ env });
      if (sessionKey) {
        const web = await fetchClaudeWebUsage({ sessionKey, timeoutMs, fetchJsonWithTimeoutImpl });
        if (web) {
          return web;
        }
      }
    }

    return {
      provider: ANTHROPIC_PROVIDER,
      ok: false,
      status: res.status,
      ...(message ? { error: message } : {}),
      ...(missingScope ? { missingScope: true } : {}),
      ...(!missingScope && (res.status === 401 || res.status === 403) ? { tokenExpired: true } : {}),
    };
  }

  const data = await res.json();
  const windows = buildClaudeUsageWindows(data);
  const opusUnavailable =
    Object.hasOwn(data ?? {}, "seven_day_opus") && (data?.seven_day_opus === null || data?.seven_day_opus === undefined);

  return {
    provider: ANTHROPIC_PROVIDER,
    ok: true,
    windows,
    ...(opusUnavailable ? { opusUnavailable: true } : {}),
  };
}

export function getCodexUsagePercents(snapshot) {
  if (!snapshot || snapshot.ok !== true) {
    return { primaryUsedPct: 100, secondaryUsedPct: 100 };
  }
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  return {
    primaryUsedPct: clampPercent(windows[0]?.usedPercent ?? 0),
    secondaryUsedPct: clampPercent(windows[1]?.usedPercent ?? 0),
  };
}

export async function probeUsageSnapshotsByProvider(state, { env = {}, fetchJsonWithTimeoutImpl = fetchJsonWithTimeout } = {}) {
  ensureStateShape(state);
  const usageByProvider = {
    [OPENAI_CODEX_PROVIDER]: {},
    [ANTHROPIC_PROVIDER]: {},
  };
  const probes = [];

  for (const [label, cred] of Object.entries(state.credentials[OPENAI_CODEX_PROVIDER])) {
    if (!isObject(cred) || typeof cred.access !== "string") continue;
    probes.push(
      (async () => {
        const accountId = typeof cred.accountId === "string" ? cred.accountId.trim() : null;
        try {
          usageByProvider[OPENAI_CODEX_PROVIDER][label] = await fetchCodexUsageSnapshot({
            accessToken: cred.access,
            accountId,
            timeoutMs: 8000,
            fetchJsonWithTimeoutImpl,
          });
        } catch (err) {
          usageByProvider[OPENAI_CODEX_PROVIDER][label] = {
            provider: OPENAI_CODEX_PROVIDER,
            ok: false,
            status: "error",
            error: String(err?.message ?? err),
          };
        }
      })(),
    );
  }

  for (const [label, cred] of Object.entries(state.credentials[ANTHROPIC_PROVIDER])) {
    if (!isObject(cred) || typeof cred.access !== "string") continue;
    probes.push(
      (async () => {
        try {
          usageByProvider[ANTHROPIC_PROVIDER][label] = await fetchClaudeUsageSnapshot({
            accessToken: cred.access,
            timeoutMs: 8000,
            env,
            fetchJsonWithTimeoutImpl,
          });
        } catch (err) {
          usageByProvider[ANTHROPIC_PROVIDER][label] = {
            provider: ANTHROPIC_PROVIDER,
            ok: false,
            status: "error",
            error: String(err?.message ?? err),
          };
        }
      })(),
    );
  }

  await Promise.all(probes);
  return usageByProvider;
}
