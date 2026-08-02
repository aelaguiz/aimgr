import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { buildLocalBrowserBindingsFromState } from "../../src/coordination/browser-policy.js";
import { buildStableIdentityForCredential } from "../../src/coordination/login-publish.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { writeLocalState } from "../../src/state/local-state.js";
import { FakeRedisClient } from "./fake-redis.js";
import { registerCliRedisFixture } from "./cli-runner.js";

function recordsFromFixtureState(state) {
  return Object.entries(state?.accounts ?? {}).map(([label, account]) => {
    const provider = account?.provider;
    const credential = state?.credentials?.[provider]?.[label] ?? {};
    let identity = {};
    try {
      identity = Object.keys(credential).length > 0
        ? buildStableIdentityForCredential(provider, credential)
        : {};
    } catch {
      identity = {};
    }
    return {
      provider,
      label,
      credential,
      identity,
      policy: {
        expect: account?.expect ?? {},
        reauth: account?.reauth ?? {},
        browser: account?.browser ?? {},
        pool: account?.pool ?? { enabled: true },
      },
      health: Object.keys(credential).length > 0
        ? { status: "ready", reason: null }
        : { status: "candidate", reason: "credential_missing" },
    };
  });
}

export async function attachRedisFixtureFromLegacyState({
  homeDir,
  statePath = path.join(homeDir, ".aimgr", "secrets.json"),
  client = new FakeRedisClient(),
  keyPrefix = `aimgr:test:${path.basename(homeDir)}:`,
} = {}) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  writeAimgrConfig({
    homeDir,
    config: { redis: { url: "redis://fake:6379", keyPrefix } },
  });
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(
    store,
    { credentials: recordsFromFixtureState(state) },
    { updatedBy: "test-fixture", observedAt: new Date().toISOString() },
  );
  writeLocalState({
    homeDir,
    localState: {
      targets: state.targets,
      pool: state.pool,
      browserBindings: buildLocalBrowserBindingsFromState(state),
    },
  });
  const connectRedisStoreImpl = () => connectRedisStore({ client, keyPrefix });
  registerCliRedisFixture(homeDir, { connectRedisStoreImpl });
  return { client, keyPrefix, store, connectRedisStoreImpl };
}
