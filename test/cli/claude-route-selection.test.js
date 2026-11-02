import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeAimgrConfig } from '../../src/config/aimgr-config.js';
import { connectRedisStore, importCredentialsSnapshot } from '../../src/coordination/redis-store.js';
import { acquireRedisCredentialLease } from '../../src/coordination/redis-credential-lease.js';
import { runAutomaticClaudeSession } from '../../src/cli/commands/claude.js';
import { FakeRedisClient } from '../helpers/fake-redis.js';
import { buildAnthropicClaudeCredential } from '../helpers/claude.js';
import { mkTempHome } from '../helpers/files.js';
import { runCli } from '../helpers/cli-runner.js';

const keyPrefix = 'aimgr:route-selection-test';
const badProfiles = { office: { socksPort: 0, expectedExits: ['127.0.0.2'] } };
function record(label, policy = {}) {
  const credential = buildAnthropicClaudeCredential({ access: `ACCESS_${label}`, emailAddress: `${label}@example.test`, organizationUuid: `org_${label}` });
  credential.nativeClaudeBundle.oauthAccount.accountUuid = `acct_${label}`;
  return { provider: 'anthropic', label, credential,
    identity: { accountUuid: `acct_${label}`, emailAddress: `${label}@example.test`, organizationUuid: `org_${label}` },
    policy: { expect: { email: `${label}@example.test` }, pool: { enabled: true }, ...policy },
  };
}
async function fixture(t, records, profiles = {}) {
  const homeDir = mkTempHome();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix });
  const configure = claudeProxyProfiles => writeAimgrConfig({ homeDir,
    config: { redis: { url: 'redis://fake:6379', keyPrefix }, claudeProxyProfiles },
  });
  configure(profiles);
  await importCredentialsSnapshot(store, { credentials: records });
  return { homeDir, store, configure, connect: () => connectRedisStore({ client, keyPrefix }) };
}
async function ordinaryUsage(_url, options) {
  assert.equal(options.headers.Authorization, 'Bearer ACCESS_ordinary');
  return { ok: true, status: 200, json: async () => ({
    five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
  }) };
}

for (const scenario of ['fresh resume', 'excluded source']) {
  test(`automatic ${scenario} cannot filter away a configured proxy failure`, async t => {
    const sourcePolicy = scenario === 'fresh resume'
      ? { reauth: { blockedReason: 'oauth_reauth_required' } }
      : { egress: { profileRef: 'office' } };
    const records = [record('source', sourcePolicy), record('ordinary')];
    if (scenario === 'fresh resume') records.push(record('protected', { egress: { profileRef: 'office' } }));
    const lane = await fixture(t, records, badProfiles);
    const thread = '33333333-3333-4333-8333-333333333333';
    const cwd = path.join(lane.homeDir, 'project');
    const project = path.join(lane.homeDir, '.aimgr/claude-homes/source/.claude/projects/project');
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${thread}.jsonl`), [
      { type: 'user', sessionId: thread, cwd, timestamp: new Date().toISOString() },
      { type: 'assistant', isSidechain: false, message: { model: 'claude-opus-4-6' }, effort: 'xhigh', timestamp: new Date().toISOString() },
    ].map(JSON.stringify).join('\n') + '\n');
    let launches = 0;
    await assert.rejects(runCli(['claude', 'resume', thread, '--home', lane.homeDir,
      ...(scenario === 'excluded source' ? ['--switch-account', 'opus'] : [])], {
      env: { HOME: lane.homeDir }, connectRedisStoreImpl: lane.connect,
      fetchJsonWithTimeoutImpl: ordinaryUsage,
      runClaudeCliImpl: () => { launches += 1; return { status: 0, signal: null }; },
    }), { code: 'invalid_proxy_profile' });
    assert.equal(launches, 0);
  });
}

test('scheduled account freeing checks new route failures before stopping an unrelated session', async t => {
  const lane = await fixture(t, [record('ordinary'), record('protected', { egress: { profileRef: 'office' } })]);
  await acquireRedisCredentialLease(lane.store, { provider: 'anthropic', label: 'ordinary' });
  let connections = 0, choices = 0, stops = 0, launches = 0;
  await assert.rejects(runAutomaticClaudeSession({
    homeDir: lane.homeDir, nowMs: Date.now(),
    connectRedisStoreImpl: () => { if (++connections === 2) lane.configure(badProfiles); return lane.connect(); },
    fetchJsonWithTimeoutImpl: ordinaryUsage,
    listLocalAimClaudeSessionsImpl: () => [{ label: 'ordinary', sessionId: 'owned-fixture' }],
    chooseClaudeAccountToFreeImpl: sessions => { choices += 1; return sessions[0]; },
    stopClaudeAccountSessionsImpl: async session => { stops += 1; return [session]; },
  }, { cwd: lane.homeDir, runSession: () => { launches += 1; } }), { code: 'invalid_proxy_profile' });
  assert.equal(connections, 2);
  assert.equal(choices, 0); assert.equal(stops, 0); assert.equal(launches, 0);
});
