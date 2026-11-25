import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeAimgrConfig } from '../../src/config/aimgr-config.js';
import { connectRedisStore, importCredentialsSnapshot } from '../../src/coordination/redis-store.js';
import { acquireRedisCredentialLease } from '../../src/coordination/redis-credential-lease.js';
import { resolveClaudeAuthFilePath } from '../../src/io/paths.js';
import { runAutomaticClaudeSession } from '../../src/cli/commands/claude.js';
import { FakeRedisClient } from '../helpers/fake-redis.js';
import { buildAnthropicClaudeCredential } from '../helpers/claude.js';
import { mkTempHome } from '../helpers/files.js';
import { runCli } from '../helpers/cli-runner.js';
import { localClaudeFixture, readClaudeTestEnvironment } from '../helpers/claude-local.js';

const keyPrefix = 'aimgr:route-selection-test';
const badProfiles = { office: { socksPort: 0, expectedExits: ['127.0.0.2'] } };
function record(label, policy = {}, credentialOptions = {}) {
  const credential = buildAnthropicClaudeCredential({
    access: `ACCESS_${label}`, emailAddress: `${label}@example.test`, organizationUuid: `org_${label}`,
    ...credentialOptions,
  });
  credential.nativeClaudeBundle.oauthAccount.accountUuid = `acct_${label}`;
  return { provider: 'anthropic', label, credential,
    identity: { accountUuid: `acct_${label}`, emailAddress: `${label}@example.test`, organizationUuid: `org_${label}` },
    policy: { expect: { email: `${label}@example.test` }, pool: { enabled: true }, ...policy },
  };
}
async function fixture(t, records, profiles = {}, skipLocal = []) {
  const homeDir = mkTempHome();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix });
  const configure = claudeProxyProfiles => writeAimgrConfig({ homeDir,
    config: { redis: { url: 'redis://fake:6379', keyPrefix }, claudeProxyProfiles },
  });
  configure(profiles);
  await importCredentialsSnapshot(store, { credentials: records });
  for (const entry of records) if (!skipLocal.includes(entry.label)) await localClaudeFixture(homeDir, entry);
  return { homeDir, store, configure, connect: () => connectRedisStore({ client, keyPrefix }) };
}
async function ordinaryUsage(_url, options) {
  assert.equal(options.headers.Authorization, 'Bearer ACCESS_ordinary');
  return { ok: true, status: 200, json: async () => ({
    five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
  }) };
}

function recordSession(homeDir) {
  const thread = '33333333-3333-4333-8333-333333333333';
  const cwd = path.join(homeDir, 'project');
  const project = path.join(homeDir, '.aimgr/claude-homes/source/.claude/projects/project');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${thread}.jsonl`);
  const contents = [
    { type: 'user', sessionId: thread, cwd, timestamp: new Date().toISOString() },
    { type: 'assistant', isSidechain: false, message: { model: 'claude-opus-4-6' }, effort: 'xhigh', timestamp: new Date().toISOString() },
  ].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(file, contents);
  return { thread, cwd, file, contents };
}

for (const scenario of ['fresh resume', 'excluded source']) {
  test(`automatic ${scenario} cannot filter away a configured proxy failure`, async t => {
    const sourcePolicy = scenario === 'fresh resume'
      ? { reauth: { blockedReason: 'oauth_reauth_required' } }
      : { egress: { profileRef: 'office' } };
    const records = [record('source', sourcePolicy), record('ordinary')];
    if (scenario === 'fresh resume') records.push(record('protected', { egress: { profileRef: 'office' } }));
    const lane = await fixture(t, records, badProfiles, scenario === 'fresh resume' ? ['source'] : []);
    const { thread } = recordSession(lane.homeDir);
    let launches = 0;
    await assert.rejects(runCli(['claude', 'resume', thread, '--home', lane.homeDir,
      ...(scenario === 'excluded source' ? ['--switch-account', 'opus'] : [])], {
      env: { HOME: lane.homeDir }, connectRedisStoreImpl: lane.connect, readClaudeEnvironmentImpl: readClaudeTestEnvironment,
      fetchJsonWithTimeoutImpl: ordinaryUsage,
      runClaudeCliImpl: () => { launches += 1; return { status: 0, signal: null }; },
    }), { code: 'invalid_proxy_profile' });
    assert.equal(launches, 0);
  });
}

const HOUR = 3_600_000;
function meter(utilization, resetAt) {
  return { utilization, resets_at: new Date(resetAt).toISOString() };
}

async function switchFixture(t, records) {
  const lane = await fixture(t, [record('source'), ...records]);
  const source = recordSession(lane.homeDir);
  const clock = { now: Date.now() };
  const responses = new Map();
  const requests = [];
  const resolve = () => process.execPath;
  resolve.prepareClaudeCliLaunchImpl = async input => input;
  const cli = {
    env: { HOME: lane.homeDir },
    nowImpl: () => clock.now,
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    connectRedisStoreImpl: lane.connect,
    resolveExecutableOnPathImpl: resolve,
    fetchJsonWithTimeoutImpl: async (_url, options) => {
      const token = options.headers.Authorization.replace(/^Bearer /, '');
      requests.push(token);
      const response = responses.get(token);
      assert.ok(response, `Unexpected usage check for ${token}`);
      if (typeof response === 'number') return { ok: false, status: response };
      return { ok: true, status: 200, json: async () => response };
    },
    runClaudeCliImpl: () => assert.fail('Claude should not launch'),
  };
  return {
    source, clock, responses, requests,
    status: (...labels) => runCli(['claude', 'status', ...labels, '--fresh', '--home', lane.homeDir], cli),
    resume: (overrides = {}) => runCli(['claude', 'resume', source.thread, '--switch-account', 'opus',
      '--home', lane.homeDir], { ...cli, ...overrides }),
  };
}

test('Claude switch checks three plausible accounts and forks once after the stale first choice hits its cap', async t => {
  const lane = await switchFixture(t, ['preferred', 'alternative', 'unknown-a', 'unknown-b'].map(label => record(label)));
  const { source, clock, requests, responses } = lane;
  const sessionReset = clock.now + HOUR;
  const weekReset = clock.now + 24 * HOUR;
  responses.set('ACCESS_preferred', { five_hour: meter(2, sessionReset), seven_day: meter(12, weekReset) });
  responses.set('ACCESS_alternative', { five_hour: meter(60, sessionReset), seven_day: meter(75, weekReset) });
  await lane.status('preferred', 'alternative');
  requests.length = 0;
  clock.now += 10 * 60_000;
  responses.set('ACCESS_preferred', { five_hour: meter(100, sessionReset) });
  responses.set('ACCESS_alternative', {
    seven_day: meter(60, weekReset), seven_day_sonnet: meter(100, weekReset),
  });
  responses.set('ACCESS_unknown-a', 503);

  let launches = 0;
  const out = await lane.resume({ runClaudeCliImpl: ({ configDir, cwd, args }) => {
    launches += 1;
    assert.equal(path.basename(path.dirname(configDir)), 'alternative');
    assert.equal(cwd, source.cwd);
    assert.deepEqual(args.slice(0, 6), ['--dangerously-skip-permissions', '--model', 'opus', '--effort', 'xhigh', '--resume']);
    const staged = args[6];
    assert.deepEqual(args.slice(7, 8), ['--fork-session']);
    assert.deepEqual(fs.readdirSync(path.dirname(staged)).filter(name => name.endsWith('.jsonl')), [path.basename(staged)]);
    const firstEntry = JSON.parse(fs.readFileSync(staged, 'utf8').split('\n')[0]);
    assert.notEqual(firstEntry.sessionId, source.thread);
    return { status: 0 };
  } });
  assert.deepEqual(requests.toSorted(), ['ACCESS_alternative', 'ACCESS_preferred', 'ACCESS_unknown-a']);
  assert.match(out, /Switching session from source to alternative using opus/);
  assert.equal(launches, 1);
  assert.equal(fs.readFileSync(source.file, 'utf8'), source.contents);
});

test('Claude switch uses the recent account with room without checking the stale leader', async t => {
  const lane = await switchFixture(t, ['preferred', 'recent'].map(label => record(label)));
  const { clock, responses, requests } = lane;
  const sessionReset = clock.now + HOUR;
  const weekReset = clock.now + 24 * HOUR;
  responses.set('ACCESS_preferred', { five_hour: meter(2, sessionReset), seven_day: meter(12, weekReset) });
  await lane.status('preferred');
  clock.now += 10 * 60_000;
  responses.set('ACCESS_recent', { five_hour: meter(60, sessionReset), seven_day: meter(75, weekReset) });
  await lane.status('recent');
  requests.length = 0;

  const labels = [];
  await lane.resume({ runClaudeCliImpl: ({ configDir }) => {
    labels.push(path.basename(path.dirname(configDir)));
    return { status: 0 };
  } });
  assert.deepEqual(labels, ['recent']);
  assert.deepEqual(requests, []);
});

test('Claude switch rechecks recent near-limit usage before forking', async t => {
  const lane = await switchFixture(t, [record('near-limit')]);
  const { clock, responses, requests } = lane;
  const reset = clock.now + HOUR;
  responses.set('ACCESS_near-limit', { five_hour: meter(97, reset) });
  await lane.status('near-limit');
  requests.length = 0;
  responses.set('ACCESS_near-limit', { five_hour: meter(98, reset) });

  const out = await lane.resume({ runClaudeCliImpl: ({ configDir }) => {
    assert.equal(path.basename(path.dirname(configDir)), 'near-limit');
    return { status: 0 };
  } });
  assert.deepEqual(requests, ['ACCESS_near-limit']);
  assert.match(out, /^Claude near-limit has 2% left in its tightest usage window for opus\.\nSwitching session/);
});

test('Claude switch reports the first account to clear all its blockers', async t => {
  const lane = await switchFixture(t, ['later', 'sooner'].map(label => record(label)));
  const { clock, requests, responses, source } = lane;
  const firstReset = clock.now + 6 * HOUR;
  responses.set('ACCESS_source', { five_hour: meter(100, clock.now + HOUR / 2) });
  responses.set('ACCESS_later', {
    five_hour: meter(100, clock.now + HOUR), seven_day: meter(100, clock.now + 48 * HOUR),
  });
  responses.set('ACCESS_sooner', {
    five_hour: meter(100, clock.now + 2 * HOUR), seven_day_opus: meter(100, firstReset),
  });
  await lane.status('source', 'later', 'sooner');
  requests.length = 0;

  await assert.rejects(lane.resume(), {
    message: `All other eligible Claude accounts are at their usage limits for opus. Earliest known reset is ${new Date(firstReset).toISOString()} on Claude sooner.`,
  });
  assert.deepEqual(requests, []);
  assert.equal(fs.readFileSync(source.file, 'utf8'), source.contents);
});

test('Claude switch does not fork on stale positive usage after a failed check or retry a recent 429', async t => {
  const lane = await switchFixture(t, ['throttled', 'capped'].map(label => record(label)));
  const { clock, requests, responses, source } = lane;
  const reset = clock.now + HOUR;
  responses.set('ACCESS_throttled', { five_hour: meter(20, reset), seven_day: meter(20, clock.now + 24 * HOUR) });
  responses.set('ACCESS_capped', { five_hour: meter(100, reset) });
  await lane.status('throttled', 'capped');
  requests.length = 0;
  clock.now += 10 * 60_000;
  responses.set('ACCESS_throttled', 429);
  const expected = {
    message: `Could not verify another Claude account with usage left for opus. Earliest known reset is ${new Date(reset).toISOString()} on Claude capped.`,
  };

  await assert.rejects(lane.resume(), expected);
  assert.deepEqual(requests, ['ACCESS_throttled']);
  await assert.rejects(lane.resume(), expected);
  assert.deepEqual(requests, ['ACCESS_throttled']);
  assert.equal(fs.readFileSync(source.file, 'utf8'), source.contents);
});

test('Claude switch renews a shortlisted idle login before checking usage', async t => {
  const lane = await switchFixture(t, [record('expired', {}, { expiresAtMs: Date.now() - 60_000 })]);
  const { clock, requests, responses } = lane;
  responses.set('ACCESS_renewed', { five_hour: meter(12, clock.now + HOUR) });
  const maintenance = [];
  const launches = [];
  await lane.resume({
    runClaudeCliNoninteractiveImpl: ({ configDir, timeoutMs, deadlineMs, args }) => {
      maintenance.push(path.basename(path.dirname(configDir)));
      assert.ok(timeoutMs > 0 && timeoutMs <= 5_000);
      assert.ok(deadlineMs <= Date.now() + timeoutMs);
      assert.ok(args.includes('--no-session-persistence'));
      assert.equal(args.at(-1), '/usage');
      assert.deepEqual(requests, []);
      const file = resolveClaudeAuthFilePath(configDir);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      saved.claudeAiOauth.accessToken = 'ACCESS_renewed';
      saved.claudeAiOauth.expiresAt = Date.now() + HOUR;
      fs.writeFileSync(file, JSON.stringify(saved));
      return { status: 0 };
    },
    runClaudeCliImpl: ({ configDir }) => {
      launches.push(path.basename(path.dirname(configDir)));
      return { status: 0 };
    },
  });
  assert.deepEqual(maintenance, ['expired']);
  assert.deepEqual(requests, ['ACCESS_renewed']);
  assert.deepEqual(launches, ['expired']);
});

test('scheduled Claude uses the local grant despite a remote legacy credential lease', async t => {
  const lane = await fixture(t, [record('ordinary')]);
  await acquireRedisCredentialLease(lane.store, { provider: 'anthropic', label: 'ordinary' });
  const resolve = () => process.execPath;
  resolve.prepareClaudeCliLaunchImpl = async input => input;
  const launches = [];
  await runAutomaticClaudeSession({
    homeDir: lane.homeDir, nowMs: Date.now(), env: { HOME: lane.homeDir }, opts: { afterDoubleDash: [] },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    connectRedisStoreImpl: lane.connect, fetchJsonWithTimeoutImpl: ordinaryUsage,
    resolveExecutableOnPathImpl: resolve, setExitCode: code => assert.fail(`unexpected exit ${code}`),
  }, { cwd: lane.homeDir, runSession: launch => { launches.push(launch.label); return { status: 0 }; } });
  assert.deepEqual(launches, ['ordinary']);
});
