import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main } from '../../src/cli/main.js';
import { handleLocalClaudeAuth } from '../../src/cli/commands/claude-local-auth.js';
import { buildRedisKeys } from '../../src/coordination/redis-store.js';
import { readLocalClaudeCredential } from '../../src/credentials/claude-local.js';
import { readLocalCodexCredential } from '../../src/credentials/codex-local.js';
import { writeAimgrConfig } from '../../src/config/aimgr-config.js';
import { recordingRedisServer, assertNoRedisSecrets } from '../helpers/recording-redis-server.js';

const label = 'synthetic';
const identity = { accountUuid: 'synthetic-account', organizationUuid: 'synthetic-org',
  organizationName: 'Synthetic', emailAddress: 'synthetic@example.invalid' };
const accountId = 'synthetic-codex-account';
const environment = { binding: 'a'.repeat(64) };
const access = 'STAND_IN_CLAUDE_ACCESS_NEVER_SEND_TO_REDIS';
const refresh = 'STAND_IN_REFRESH_NEVER_SEND_TO_REDIS';
const code = 'STAND_IN_AUTH_CODE_NEVER_SEND_TO_REDIS';
const jwt = kind => 'e30.' + Buffer.from(JSON.stringify({ chatgpt_account_id: accountId,
  exp: Math.floor(Date.now() / 1000) + 3600, sentinel: `STAND_IN_${kind}_NEVER_SEND_TO_REDIS` })).toString('base64url') + '.synthetic';

test('Redis command guard rejects stand-in secrets in keys, values and Lua arguments', () => {
  for (const command of [['SET', refresh, 'value'], ['SET', 'key', JSON.stringify({refresh})],
    ['EVAL', 'return ARGV[1]', '0', refresh]]) {
    assert.throws(() => assertNoRedisSecrets([command], [refresh]), /stand-in credential reached Redis/);
  }
});

for (const provider of ['claude', 'codex']) for (const existing of [true, false]) {
  test(`${provider} manual login: ${existing ? 'existing shared label' : 'new label'} sends no stand-in credential in any Redis command`,
    { timeout: 20000 }, async t => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-login-wire-'));
      t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
      const wire = await recordingRedisServer(t);
      writeAimgrConfig({homeDir, config: {redis: {url: wire.url, keyPrefix: 'fixture:'}}});
      const providerId = provider === 'claude' ? 'anthropic' : 'openai-codex';
      const keys = buildRedisKeys('fixture:');
      const key = keys.credential({provider: providerId, label});
      const legacy = { access: 'OLD_SHARED_ACCESS', refresh: 'OLD_SHARED_REFRESH' };
      const record = {kind: 'aimgr.credential.v1', provider: providerId, label,
        identity: provider === 'claude' ? identity : {accountId},
        policy: {expect: provider === 'claude' ? {email: identity.emailAddress} : {}},
        credential: legacy, version: 9, updatedAt: '2026-01-01T00:00:00.000Z'};
      if (existing) {
        // Seed the fake server directly; the recorded wire starts at CLI login.
        await wire.database.set(key, JSON.stringify(record));
        await wire.database.sAdd(keys.credentials(), key);
        await wire.database.sAdd(keys.credentialsByProvider(providerId), key);
      }
      const accessJwt = jwt('ACCESS'), idJwt = jwt('ID');
      const secrets = [access, refresh, code, accessJwt, idJwt];
      // Check even when login fails: an attempted leak must not be hidden by
      // a later failed publication, transaction, or local-storage error.
      t.after(() => assertNoRedisSecrets(wire.commands, secrets));
      const stdin = new PassThrough(), stdout = new PassThrough();
      let output = '', exitCode = 0, child;
      t.after(() => {child?.kill(); stdin.destroy(); stdout.destroy();});
      stdout.on('data', bytes => {
        output += bytes.toString();
        for (const line of bytes.toString().trim().split('\n')) {
          const event = JSON.parse(line);
          if (event.type !== 'auth_url') continue;
          const auth = new URL(event.url);
          const callback = new URL(provider === 'claude'
            ? 'https://platform.claude.com/oauth/code/callback' : 'http://localhost:1455/auth/callback');
          callback.search = new URLSearchParams({code, state: auth.searchParams.get('state')});
          stdin.write(JSON.stringify({url: callback.href}) + '\n');
        }
      });
      if (provider === 'claude') {
        const authorize = 'https://claude.com/cai/oauth/authorize?state=synthetic-state&client_id=fixture&code_challenge=fixture&code_challenge_method=S256&redirect_uri='
          + encodeURIComponent('https://platform.claude.com/oauth/code/callback');
        // Native stand-in performs the manual stdin handoff and writes the
        // native files. AIM's real parsing, metadata publication and local
        // credential persistence run unchanged afterward.
        const script = `
          const fs=require('node:fs'),path=require('node:path');
          const input=require('node:readline').createInterface({input:process.stdin,terminal:false});
          input.on('line',line=>{
            if(line!==${JSON.stringify(code + '#synthetic-state')}) process.exit(9);
            fs.writeFileSync(path.join(process.argv[1],'.credentials.json'),JSON.stringify({claudeAiOauth:{
              accessToken:${JSON.stringify(access)},refreshToken:${JSON.stringify(refresh)},expiresAt:Date.now()+3600000,
              scopes:['user:profile','user:inference'],subscriptionType:'max',rateLimitTier:'default_claude_max_20x'}}),{mode:0o600});
            fs.writeFileSync(path.join(process.argv[1],'.claude.json'),JSON.stringify({oauthAccount:${JSON.stringify(identity)}}),{mode:0o600});
            process.exit(0);
          });
          process.stdout.write(${JSON.stringify(authorize + '\n')});`;
        const resolve = () => process.execPath;
        resolve.prepareClaudeCliLaunchImpl = async options => options;
        await handleLocalClaudeAuth({homeDir, positional: ['claude', 'login', label],
          opts: {manualCallbackStdio: true, claudeLoginEmail: identity.emailAddress}, stdin, stdout, env: {...process.env},
          readClaudeEnvironmentImpl: () => environment, resolveExecutableOnPathImpl: resolve,
          assertClaudeNativeOwnersStoppedImpl: async () => {}, setExitCode: value => {exitCode = value;},
          runClaudeCliImpl: async launch => {
            child = launch.spawnImpl(process.execPath, ['-e', script, launch.configDir],
              {env: launch.env, signal: launch.signal, stdio: ['inherit', 'inherit', 'inherit']});
            return new Promise((resolve, reject) => {
              child.once('error', reject); child.once('close', (status, signal) => resolve({status, signal}));
            });
          }});
        const local = readLocalClaudeCredential({homeDir, label, metadata: record, environment, command: process.execPath});
        assert.equal(local.status, 'ready');
        assert.equal(local.nativeClaudeBundle.claudeAiOauth.accessToken, access);
        assert.equal(local.nativeClaudeBundle.claudeAiOauth.refreshToken, refresh);
      } else {
        let exchanges = 0;
        await main(['codex', 'login', label, '--home', homeDir, '--manual-callback-stdio'], {
          stdin, stdout, env: {}, readCodexEnvironmentImpl: () => environment,
          setExitCode: value => {exitCode = value;},
          openUrlImpl: () => assert.fail('must not open a browser'),
          fetchJsonWithTimeoutImpl: async (url, options) => {
            exchanges++;
            assert.equal(url, 'https://auth.openai.com/oauth/token');
            assert.equal(options.body.get('code'), code);
            return {ok: true, json: async () => ({access_token: accessJwt, id_token: idJwt, refresh_token: refresh, expires_in: 3600})};
          }});
        assert.equal(exchanges, 1);
        const local = readLocalCodexCredential({homeDir, environment, accountId});
        assert.equal(local.status, 'ready');
        assert.equal(local.credential.access, accessJwt);
        assert.equal(local.credential.refresh, refresh);
      }
      assert.equal(exitCode, 0);
      assert.deepEqual(output.trim().split('\n').map(line => JSON.parse(line).type), ['auth_url', 'result']);
      const writes = wire.commands.filter(command => command[0] === 'EVAL' && command[1].includes(
        provider === 'claude' ? 'AIMGR_CLAUDE_METADATA_ENSURE_V1' : 'AIMGR_CODEX_METADATA_CREATE_V1'));
      assert.equal(writes.length, 1, 'must exercise the actual login metadata publication');
      assert.equal(wire.commands.filter(command => command[0] === 'QUIT').length, 2, 'capture both login connections');
      assertNoRedisSecrets(wire.commands, secrets);
      const after = JSON.parse(await wire.database.get(key));
      assert.deepEqual(after.credential, existing ? legacy : {});
      if (existing && provider === 'codex') assert.deepEqual(after, record);
      if (existing && provider === 'claude') assert.equal(after.version, record.version + 1);
      t.diagnostic(`Inspected all ${wire.commands.length} Redis commands across both login connections; no stand-in credentials present.`);
    });
}
