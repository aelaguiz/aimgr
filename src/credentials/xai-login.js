import { XAI_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { toIsoFromExpiresMs } from "../core/time.js";
import { persistXaiCredentialForLabel } from "./xai.js";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

function requiredString(body, field) {
  const value = body?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`xAI OAuth response is missing ${field}`);
  }
  return value;
}

function optionalPositiveNumber(body, field) {
  const value = body?.[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function decodeJwtPayload(token) {
  const raw = String(token ?? "").trim();
  const parts = raw.split(".");
  if (parts.length < 2) return {};
  const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
  try {
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function emailFromXaiTokenResponse(body) {
  const idToken = typeof body?.id_token === "string" ? body.id_token : "";
  const payload = decodeJwtPayload(idToken);
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  return email;
}

export function credentialsFromXaiTokenResponse(body, previousRefreshToken) {
  const rotatedRefresh = typeof body?.refresh_token === "string" && body.refresh_token.trim();
  const refresh = rotatedRefresh ? body.refresh_token.trim() : String(previousRefreshToken ?? "").trim();
  if (!refresh) {
    throw new Error("xAI OAuth response is missing refresh_token");
  }
  const expiresInSeconds = optionalPositiveNumber(body, "expires_in") ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
  const expiresAt = toIsoFromExpiresMs(Date.now() + expiresInSeconds * 1000);
  const emailAddress = emailFromXaiTokenResponse(body);
  return {
    access: requiredString(body, "access_token"),
    refresh,
    expiresAt,
    emailAddress,
  };
}

async function postForm(fetchImpl, url, fields) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
  let body = {};
  try {
    const parsed = await response.json();
    if (isObject(parsed)) body = parsed;
  } catch {
    throw new Error(`xAI OAuth endpoint returned invalid JSON (HTTP ${response.status})`);
  }
  return { ok: response.ok, status: response.status, body };
}

export async function requestXaiDeviceAuthorization({ fetchImpl = globalThis.fetch } = {}) {
  const response = await postForm(fetchImpl, XAI_DEVICE_CODE_URL, {
    client_id: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPE,
  });
  if (!response.ok) {
    const detail = [response.body.error, response.body.error_description].filter(Boolean).join(": ");
    throw new Error(`xAI device authorization failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return {
    deviceCode: requiredString(response.body, "device_code"),
    userCode: requiredString(response.body, "user_code"),
    verificationUri: requiredString(response.body, "verification_uri"),
    verificationUriComplete: typeof response.body.verification_uri_complete === "string"
      ? response.body.verification_uri_complete
      : "",
    intervalSeconds: optionalPositiveNumber(response.body, "interval") ?? DEFAULT_POLL_INTERVAL_SECONDS,
    expiresInSeconds: optionalPositiveNumber(response.body, "expires_in") ?? 900,
  };
}

export async function pollXaiDeviceTokens({
  device,
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowMsImpl = Date.now,
}) {
  const deadline = nowMsImpl() + device.expiresInSeconds * 1000;
  let intervalSeconds = device.intervalSeconds;
  while (nowMsImpl() < deadline) {
    await sleepImpl(Math.min(intervalSeconds * 1000, Math.max(0, deadline - nowMsImpl())));
    if (nowMsImpl() >= deadline) break;
    const response = await postForm(fetchImpl, XAI_TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: XAI_OAUTH_CLIENT_ID,
      device_code: device.deviceCode,
    });
    if (response.ok) return credentialsFromXaiTokenResponse(response.body);
    const error = response.body.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalSeconds = Math.max(optionalPositiveNumber(response.body, "interval") ?? 0, intervalSeconds + 5);
      continue;
    }
    if (error === "access_denied") throw new Error("xAI device authorization was denied");
    if (error === "expired_token") break;
    const detail = [error, response.body.error_description].filter(Boolean).join(": ");
    throw new Error(`xAI device token polling failed${detail ? `: ${detail}` : ""}`);
  }
  throw new Error("xAI device code expired before the login was approved.");
}

export async function refreshXaiCredential({
  refreshToken,
  fetchImpl = globalThis.fetch,
}) {
  const response = await postForm(fetchImpl, XAI_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  if (!response.ok) {
    const error = typeof response.body.error === "string" ? response.body.error : "";
    if (error === "invalid_grant") {
      const err = new Error("xAI refresh was rejected; reauthentication is required.");
      err.code = "oauth_reauth_required";
      throw err;
    }
    const detail = [error, response.body.error_description].filter(Boolean).join(": ");
    throw new Error(`xAI refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return credentialsFromXaiTokenResponse(response.body, refreshToken);
}

export async function loginXaiDevice({
  expectedEmail,
  fetchImpl = globalThis.fetch,
  sleepImpl,
  nowMsImpl,
  openUrlImpl,
  writeImpl = () => {},
}) {
  const wanted = String(expectedEmail ?? "").trim().toLowerCase();
  if (!wanted) {
    throw new Error("xAI login requires an expected email.");
  }
  const device = await requestXaiDeviceAuthorization({ fetchImpl });
  const url = device.verificationUriComplete || device.verificationUri;
  writeImpl(`Open this URL and confirm code ${device.userCode}:\n${url}\n`);
  if (typeof openUrlImpl === "function") {
    try {
      await openUrlImpl(url);
    } catch {
      writeImpl("Could not open a browser automatically. Use the URL above.\n");
    }
  }
  const credential = await pollXaiDeviceTokens({ device, fetchImpl, sleepImpl, nowMsImpl });
  if (!credential.emailAddress) {
    throw new Error("xAI login did not return an email in the id_token.");
  }
  if (credential.emailAddress !== wanted) {
    throw new Error(
      `xAI login identity_mismatch: expected ${wanted} but the approved account was ${credential.emailAddress}.`,
    );
  }
  return credential;
}

export function storeXaiLoginCredential({ state, label, credential }) {
  return persistXaiCredentialForLabel({
    state,
    label: normalizeLabel(label),
    credential,
  });
}

export function hasXaiRefreshMaterial(credential) {
  return Boolean(
    typeof credential?.refresh === "string"
    && credential.refresh.trim()
    && typeof credential?.access === "string"
    && credential.access.trim()
  );
}

export { XAI_PROVIDER };

export async function maintainRedisXaiCredential({
  runtime,
  record,
  fetchImpl = globalThis.fetch,
}) {
  const refreshToken = typeof record?.credential?.refresh === "string" ? record.credential.refresh.trim() : "";
  if (!refreshToken) {
    return { outcome: "reauth_required", reason: "refresh_material_missing" };
  }
  let next;
  try {
    next = await refreshXaiCredential({ refreshToken, fetchImpl });
  } catch (error) {
    if (error?.code === "oauth_reauth_required") {
      return { outcome: "reauth_required", reason: "refresh_rejected" };
    }
    throw error;
  }
  if (!next.emailAddress) {
    next.emailAddress = typeof record.credential?.emailAddress === "string"
      ? record.credential.emailAddress
      : "";
  }
  persistXaiCredentialForLabel({
    state: runtime.state,
    label: record.label,
    credential: next,
  });
  const { publishMaintainedCredential } = await import("../coordination/login-publish.js");
  const published = await publishMaintainedCredential({
    store: runtime.store,
    snapshot: runtime.snapshot,
    state: runtime.state,
    label: record.label,
    provider: XAI_PROVIDER,
    observedAt: new Date().toISOString(),
  });
  if (!published.ok) {
    throw new Error(`Redis publish failed for label=${record.label}: ${published.credential?.code ?? "unknown"}`);
  }
  runtime.snapshot = {
    ...runtime.snapshot,
    credentials: (runtime.snapshot.credentials ?? []).map((item) => (
      item.provider === XAI_PROVIDER && item.label === record.label
        ? published.credential.record
        : item
    )),
  };
  const unchanged = next.refresh === refreshToken && next.access === record.credential.access;
  return { outcome: unchanged ? "unchanged" : "refreshed", reason: unchanged ? "tokens_unchanged" : "credential_rotated" };
}
