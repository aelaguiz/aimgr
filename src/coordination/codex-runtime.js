import { getRedisConfig } from "../config/aimgr-config.js";
import path from "node:path";
import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { readLocalCodexCredential, maintainLocalCodexCredential } from "../credentials/codex-local.js";
import { readCodexEnvironment } from "../privacy/codex-environment.js";
import { loadLocalState } from "../state/local-state.js";
import { buildCoordinationView } from "./snapshot.js";
import { readCodexAccountMetadata } from "./codex-metadata.js";
import { connectRedisStore, closeRedisStore, readAccountNotes, REDIS_CONNECTION_POLICY_ONE_SHOT } from "./redis-store.js";

export async function localCodexRecords({ store, homeDir, env = {}, environment, maintain = false, fetchJsonWithTimeoutImpl, signal }) {
  const records = [];
  for (const item of await readCodexAccountMetadata(store)) {
    const options = { homeDir, env, environment, accountId: item.accountId };
    let local = { status: environment ? "login_required" : "runtime_required", credential: null };
    if (item.accountId && environment) {
      try {
        local = maintain ? await maintainLocalCodexCredential(options, { fetchJsonWithTimeoutImpl, signal })
          : readLocalCodexCredential(options);
      } catch {
        // One broken local grant or unavailable refresh must not hide healthy
        // accounts or make another account fall back to its legacy Redis grant.
        local = { status: "local_auth_unavailable", credential: null };
      }
    }
    records.push({ provider: OPENAI_CODEX_PROVIDER, label: item.label, identity: { accountId: item.accountId },
      localAccountKey: local.paths ? path.basename(local.paths.accountRoot) : null,
      credential: local.credential ?? {}, policy: { ...item.policy,
        reauth: { mode: "manual-callback", required: !local.credential } },
      health: { status: local.status === "ready" ? "ready" : "candidate", reason: local.status === "ready" ? null : local.status },
    });
  }
  return records;
}

export async function loadCodexRuntime({ homeDir, env = {}, connectRedisStoreImpl = connectRedisStore,
  environment, readCodexEnvironmentImpl = readCodexEnvironment, maintain = false, fetchJsonWithTimeoutImpl, signal } = {}) {
  const { redis } = getRedisConfig({ homeDir });
  environment ??= readCodexEnvironmentImpl();
  const store = await connectRedisStoreImpl({ ...redis, connectionPolicy: REDIS_CONNECTION_POLICY_ONE_SHOT });
  try {
    const credentials = await localCodexRecords({ store, homeDir, env, environment, maintain, fetchJsonWithTimeoutImpl, signal });
    // Notes are advisory and never supply credentials or affect account selection.
    const accountNotes = await readAccountNotes(store).catch(() => null);
    const localState = loadLocalState({ homeDir });
    const snapshot = { credentials, observedAt: new Date().toISOString(), keyPrefix: store.keyPrefix };
    const state = buildCoordinationView(snapshot, { localState, provider: OPENAI_CODEX_PROVIDER });
    state.codexEnvironment = environment;
    return { redis, store, state, snapshot, accountNotes, localState, environment, updatedBy: "aimgr-cli", providerScope: OPENAI_CODEX_PROVIDER };
  } catch (error) { await closeRedisStore(store).catch(() => {}); throw error; }
}
