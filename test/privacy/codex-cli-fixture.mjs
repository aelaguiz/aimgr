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
import { saveLocalCodexLogin, readLocalCodexCredential } from "../../src/credentials/codex-local.js";
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
  assert.ok(process.argv.length === 4 || process.argv.length === 5 && process.argv[4] === "--pool");
  const selected = process.argv[3].toLowerCase();
  assert.match(selected, /^[ab]$/);
  const labels = process.argv[4] ? ["a", "b"] : [selected], prepared = {};
  const environment = readCodexEnvironment();
  for (const label of labels) {
    const accountId = "synthetic-cli-" + label;
    const claims = { exp: Math.floor(Date.now() / 1000) + 6 * 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user" } };
    const access = `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    saveLocalCodexLogin({ homeDir, env: process.env, accountId, environment },
      { access, idToken: access, refresh: "SYNTHETIC_LOCAL_REFRESH_" + label, accountId });
    prepared[label] = prepareCodexAccountState({ homeDir, env: process.env, accountId, environment, label });
  }
  fs.writeFileSync(file, JSON.stringify({ label: selected, labels }), { mode: 0o600, flag: "wx" });
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://synthetic.invalid:6379", keyPrefix } } });
  process.stdout.write(JSON.stringify({ codexHome: prepared[selected].codexHome, installationId: prepared[selected].installationId,
    accounts: Object.fromEntries(Object.entries(prepared).map(([label, value]) => [label,
      { codexHome: value.codexHome, installationId: value.installationId, accountId: value.accountId }])) }) + "\n");
} else {
  assert.ok(["--", "--aim"].includes(process.argv[2]));
  const { label, labels } = JSON.parse(fs.readFileSync(file, "utf8"));
  const client = new FakeRedisClient(), store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(store, { credentials: labels.map(label => {
    const accountId = "synthetic-cli-" + label;
    return { provider: "openai-codex", label, identity: { accountId },
    credential: { access: "SYNTHETIC_FOREIGN_ACCESS", refresh: "SYNTHETIC_FOREIGN_REFRESH", accountId },
    policy: { pool: { enabled: true } }, health: { status: "ready", reason: null } }; }) },
    { updatedBy: "synthetic", observedAt: new Date().toISOString() });
  const recordKeys = labels.map(label => store.keys.credential({ provider: "openai-codex", label }));
  const before = await Promise.all(recordKeys.map(key => client.get(key)));
  const command = process.argv[2] === "--" ? ["codex", "run", label, "--", ...process.argv.slice(3)] : process.argv.slice(3);
  await main(["--home", homeDir, ...command], {
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }),
    fetchJsonWithTimeoutImpl: async (url, request) => {
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      const accountId = request.headers["ChatGPT-Account-Id"];
      assert.ok(labels.some(label => accountId === "synthetic-cli-" + label));
      const local = readLocalCodexCredential({ homeDir, env: process.env, accountId, environment: readCodexEnvironment() });
      assert.equal(request.headers.Authorization, "Bearer " + local.credential.access);
      fs.appendFileSync(path.join(homeDir, "aim-usage.private.jsonl"), JSON.stringify({ accountId, localAuthority: true }) + "\n", { mode: 0o600 });
      return { ok: true, status: 200, json: async () => ({ plan_type: "plus", rate_limit: { allowed: true,
        primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }) };
    },
  });
  assert.deepEqual(await Promise.all(recordKeys.map(key => client.get(key))), before,
    "native launch never publishes local primary credentials into Redis");
}
