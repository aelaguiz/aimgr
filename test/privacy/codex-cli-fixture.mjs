// Isolated integration driver: only Redis transport is synthetic. AIM's real
// parser, selection, local auth, launch preparation and native runner execute.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { main } from "../../src/cli/main.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { saveLocalCodexLogin } from "../../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../../src/privacy/codex-account-state.js";
import { readCodexEnvironment } from "../../src/privacy/codex-environment.js";

const base = "/opt/aimgr-state-audit";
assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) && process.getuid() !== 0);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const homeDir = fs.realpathSync(process.env.HOME);
assert.ok(homeDir.startsWith(base + "/"));
const file = path.join(homeDir, "aim-synthetic-account.json");
const keyPrefix = "aimgr:synthetic-native-cli";
if (process.argv[2] === "--prepare") {
  assert.equal(process.argv.length, 4);
  const label = process.argv[3].toLowerCase(), accountId = "synthetic-cli-" + label;
  assert.match(label, /^[ab]$/);
  const claims = { exp: Math.floor(Date.now() / 1000) + 6 * 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user" } };
  const access = `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const environment = readCodexEnvironment();
  saveLocalCodexLogin({ homeDir, env: process.env, accountId, environment },
    { access, idToken: access, refresh: "SYNTHETIC_LOCAL_REFRESH_" + label, accountId });
  const prepared = prepareCodexAccountState({ homeDir, env: process.env, accountId, environment, label });
  fs.writeFileSync(file, JSON.stringify({ label, accountId }), { mode: 0o600, flag: "wx" });
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://synthetic.invalid:6379", keyPrefix } } });
  process.stdout.write(JSON.stringify({ codexHome: prepared.codexHome, installationId: prepared.installationId }) + "\n");
} else {
  assert.equal(process.argv[2], "--");
  const { label, accountId } = JSON.parse(fs.readFileSync(file, "utf8"));
  const client = new FakeRedisClient(), store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(store, { credentials: [{ provider: "openai-codex", label, identity: { accountId },
    credential: { access: "SYNTHETIC_FOREIGN_ACCESS", refresh: "SYNTHETIC_FOREIGN_REFRESH", accountId },
    policy: { pool: { enabled: true } }, health: { status: "ready", reason: null } }] },
    { updatedBy: "synthetic", observedAt: new Date().toISOString() });
  const recordKey = store.keys.credential({ provider: "openai-codex", label });
  const before = await client.get(recordKey);
  await main(["codex", "run", label, "--home", homeDir, "--", ...process.argv.slice(3)], {
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }),
    fetchJsonWithTimeoutImpl: async () => { throw new Error("Unexpected AIM auth or usage request in fresh explicit-account fixture"); },
  });
  assert.equal(await client.get(recordKey), before, "native launch never publishes local primary credentials into Redis");
}
