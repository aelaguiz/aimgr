import { XAI_PROVIDER } from "../../core/constants.js";
import { normalizeLabel, isObject } from "../../core/normalize.js";
import { resolveSupportedProviderFromInput } from "../../credentials/oauth.js";
import { loginXaiDevice, storeXaiLoginCredential } from "../../credentials/xai-login.js";
import { publishMaintainedCredential } from "../../coordination/login-publish.js";
import { closeRedisRuntime, loadRedisRuntime, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { REDIS_CONNECTION_POLICY_LEASED } from "../../coordination/redis-store.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { writeJsonLine } from "../manual-callback-stdio.js";

async function performRedisXaiLogin(context, { store, snapshot, state, localState, label, writeImpl }) {
  const {
    homeDir,
    promptLineImpl,
    openUrlImpl,
    fetchImpl,
    nowMs,
  } = context;
  const existing = state.accounts[label];
  const expectedEmail = String(
    existing?.expect?.email
    || await promptLineImpl(`Expected SuperGrok email for "${label}":`),
  ).trim().toLowerCase();
  if (!expectedEmail) {
    throw new Error(`xAI label=${label} requires an expected email before login.`);
  }
  if (!isObject(existing) || !existing.provider) {
    state.accounts[label] = {
      ...(isObject(existing) ? existing : {}),
      provider: XAI_PROVIDER,
      expect: {
        ...(existing?.expect ?? {}),
        email: expectedEmail,
      },
      pool: existing?.pool ?? { enabled: true },
    };
  } else {
    state.accounts[label] = {
      ...existing,
      expect: {
        ...(existing.expect ?? {}),
        email: expectedEmail,
      },
    };
  }
  const credential = await loginXaiDevice({
    expectedEmail,
    fetchImpl: fetchImpl ?? globalThis.fetch.bind(globalThis),
    openUrlImpl,
    writeImpl,
  });
  storeXaiLoginCredential({ state, label, credential });
  const published = await publishMaintainedCredential({
    store,
    snapshot,
    state,
    label,
    provider: XAI_PROVIDER,
    observedAt: new Date(nowMs).toISOString(),
  });
  if (!published.ok) {
    throw new Error(`Redis publish failed for label=${label}: ${published.credential?.code ?? "unknown"}`);
  }
  writeRedisLocalStateFromView({ homeDir, state, localState });
  return {
    ok: true,
    label,
    provider: XAI_PROVIDER,
    maintenance: {
      action: "xai-login",
      observedAt: published.credential.record.updatedAt,
    },
    redis: { credentialVersion: published.credential.record.version },
  };
}

export async function handleLogin(context) {
  const { opts, positional, shorthandLabel, stdout, homeDir, nowMs } = context;
  const label = normalizeLabel(shorthandLabel ?? positional[1]);
  const provider = resolveSupportedProviderFromInput(opts.provider);
  // Do this before loading shared credentials or starting a native process.
  if (shorthandLabel || provider !== XAI_PROVIDER) {
    const error = `Claude and Codex login now use manual callbacks: run \`aim claude login ${label}\` or \`aim codex login ${label}\` (add --manual-callback-stdio for automation). Shared-grant enrollment and the label login panel have been removed.`;
    if (opts.manualCallbackStdio) {
      writeJsonLine(stdout, { type: "error", ok: false, label, error });
      context.setExitCode(1);
      return;
    }
    throw new Error(error);
  }
  if (opts.manualCallbackStdio) throw new Error("xAI uses device-code login, not manual callbacks.");
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl: context.connectRedisStoreImpl,
    now: new Date(nowMs), connectionPolicy: REDIS_CONNECTION_POLICY_LEASED });
  try {
    const result = await performRedisXaiLogin(context, { ...runtime, label, writeImpl: chunk => stdout.write(chunk) });
    stdout.write(`${JSON.stringify(sanitizeForStatus(result), null, 2)}\n`);
  } finally { await closeRedisRuntime(runtime); }
}
