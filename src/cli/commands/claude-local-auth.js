import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { normalizeLabel } from '../../core/normalize.js';
import { loadClaudeRuntime } from '../../coordination/claude-runtime.js';
import { ensureClaudeAccountMetadata } from '../../coordination/claude-metadata.js';
import { closeRedisRuntime } from '../../coordination/runtime.js';
import { buildCoordinationView } from '../../coordination/snapshot.js';
import { resolveNativeAccountProfile } from '../../network/claude-native-route.js';
import { closeClaudeLoginTabs, validateClaudeChrome } from '../../browser/claude-cdp.js';
import { localClaudePaths, saveLocalClaudeLogin, logoutLocalClaudeCredential } from '../../credentials/claude-local.js';
import { buildManagedClaudeNativeStorageDescriptor, ensureSafeManagedClaudeStorage, readManagedClaudeNativeBundleFromFiles } from '../../credentials/claude-native-storage.js';
import { writeJsonFileIfChanged } from "../../io/json-store.js";
import { prepareClaudeCliLaunch, runClaudeCli } from '../../targets/claude-runner.js';

// Native owns PKCE, exchange and storage. This bridge only carries its URL and
// its own manual code#state input; it never implements an OAuth exchange.
export function validateClaudeManualCallback(input, advertised) {
  const authorize = new URL(advertised);
  const state = authorize.searchParams.get('state');
  if (!state) throw new Error('Claude authorization URL has no state.');
  let code;
  if (typeof input?.url === 'string' && !input.code) {
    const callback = new URL(input.url), redirect = new URL(authorize.searchParams.get('redirect_uri'));
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.searchParams.get('state') !== state || callback.searchParams.has('error')) throw new Error('Claude callback does not match its native login.');
    code = callback.searchParams.get('code');
  } else if (typeof input?.code === 'string' && !input.url) {
    const parts = input.code.split('#');
    if (parts.length !== 2 || parts[1] !== state) throw new Error('Claude callback does not match its native login.');
    code = parts[0];
  }
  if (typeof code !== 'string' || !code || code.length > 8192 || /[\r\n\0#]/.test(code)) throw new Error('Claude callback is invalid.');
  return `${code}#${state}`;
}

export async function handleLocalClaudeAuth(context) {
  const { homeDir, opts, positional, stdout, stdin, env } = context;
  const label = normalizeLabel(positional[2]);
  if (positional.length !== 3) throw new Error('Usage: aim claude login <label> [--manual-callback-stdio] | aim claude logout <label>');
  const manual = opts.manualCallbackStdio === true;
  const emit = value => stdout.write(`${JSON.stringify(value)}\n`);
  let runtime, stagingHome, input, interval, timeout, child;
  try {
    runtime = await loadClaudeRuntime({ homeDir, connectRedisStoreImpl: context.connectRedisStoreImpl,
      readClaudeEnvironmentImpl: context.readClaudeEnvironmentImpl, allowOffline: positional[1] === 'logout' });
    let metadata = runtime.snapshot.credentials.find(item => item.label === label);
    const command = context.resolveExecutableOnPathImpl?.('claude');
    if (positional[1] === 'logout') {
      if (!metadata) throw new Error(`Claude ${label}: local account metadata is unavailable; sign-out was not performed.`);
      if (metadata) await logoutLocalClaudeCredential({ homeDir, label, metadata, environment: runtime.environment, command,
        ...(context.assertClaudeNativeOwnersStoppedImpl ? { assertStopped: context.assertClaudeNativeOwnersStoppedImpl } : {}) });
      const result = { type: 'result', ok: true, label, provider: 'anthropic', authority: 'environment-local' };
      if (manual || opts.json) emit(result); else stdout.write(`Claude ${label} is signed out on this machine.\n`);
      return;
    }
    const expectedEmail = metadata?.policy?.expect?.email ?? metadata?.identity?.emailAddress
      ?? String(await context.promptLineImpl(`Expected Claude email for "${label}":`)).trim().toLowerCase();
    if (!expectedEmail) throw new Error('Claude login requires an expected email.');
    metadata ??= { provider: 'anthropic', label, policy: { expect: { email: expectedEmail } }, identity: {}, credential: {} };
    const state = buildCoordinationView({ credentials: [metadata] }, { localState: runtime.localState, provider: 'anthropic' });
    const profile = resolveNativeAccountProfile({ homeDir, state, label });
    if (profile && !manual) await (context.validateClaudeChromeImpl ?? validateClaudeChrome)(profile);
    const paths = localClaudePaths({ homeDir, label, metadata });
    fs.mkdirSync(paths.claudeHome, { recursive: true, mode: 0o700 });
    const candidateStaging = path.join(paths.claudeHome, ".login-staging");
    fs.mkdirSync(candidateStaging, { mode: 0o700 });
    stagingHome = candidateStaging;
    const configDir = path.join(stagingHome, '.claude');
    const descriptor = buildManagedClaudeNativeStorageDescriptor({ configDir, expectedEmail,
      defaultConfigDir: path.join(homeDir, '.claude'), managedRootDir: path.join(homeDir, '.aimgr') });
    ensureSafeManagedClaudeStorage({ descriptor });
    const prepare = context.resolveExecutableOnPathImpl?.prepareClaudeCliLaunchImpl ?? prepareClaudeCliLaunch;
    const preparedLaunch = await prepare({ command, userHomeDir: homeDir, homeDir: stagingHome, configDir });
    const urlPath = path.join(stagingHome, 'native-login-url.json');
    const tabs = path.join(stagingHome, 'login-tabs.jsonl');
    const loginEnv = { ...env, BROWSER: fileURLToPath(new URL('../../../scripts/claude-login-browser.mjs', import.meta.url)),
      AIMGR_CLAUDE_LOGIN_PROFILE: JSON.stringify(profile), AIMGR_CLAUDE_LOGIN_TABS: tabs,
      ...(manual ? { AIMGR_CLAUDE_LOGIN_STDIO_URL: urlPath } : {}) };
    delete loginEnv.DISPLAY; delete loginEnv.WAYLAND_DISPLAY;
    const abort = new AbortController();
    let callbackFailure, advertised, received = false;
    let spawnImpl;
    if (manual) {
      input = readline.createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
      input.on('line', line => {
        try {
          if (received || !advertised || Buffer.byteLength(line) > 16384) throw new Error();
          received = true;
          const value = validateClaudeManualCallback(JSON.parse(line), advertised);
          child.stdin.write(value + '\n');
        } catch { callbackFailure = new Error('Claude callback did not match the current native login.'); abort.abort(callbackFailure); }
      });
      input.on('close', () => { if (!received) { callbackFailure = new Error('Claude callback input closed.'); abort.abort(callbackFailure); } });
      spawnImpl = (binary, args, options) => {
        child = spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'pipe', ...options.stdio.slice(3)] });
        // Native prompts may contain URL/code. Only the explicit JSONL bridge
        // crosses stdout; discard all vendor text from automation receipts.
        child.stdout.resume(); child.stderr.resume();
        return child;
      };
      interval = setInterval(() => {
        if (advertised) return;
        try {
          const stat = fs.lstatSync(urlPath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 16384) throw new Error();
          const record = JSON.parse(fs.readFileSync(urlPath, 'utf8'));
          const url = new URL(record.url);
          if (url.protocol !== 'https:' || !['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname)
            || !url.searchParams.get('state')) throw new Error();
          advertised = url.href;
          fs.unlinkSync(urlPath);
          emit({ type: 'auth_url', provider: 'anthropic', label, url: advertised });
        } catch (error) { if (error.code !== 'ENOENT') { callbackFailure = new Error('Claude native authorization URL was unavailable.'); abort.abort(callbackFailure); } }
      }, 100);
      timeout = setTimeout(() => abort.abort(new Error('Claude login timed out.')), 5 * 60_000);
    }
    let launched;
    try {
      launched = await (context.runClaudeCliImpl ?? runClaudeCli)({ command: preparedLaunch.command, preparedLaunch,
        userHomeDir: homeDir, homeDir: stagingHome, configDir, cwd: process.cwd(), egressProfile: profile,
        args: ['auth', 'login', '--claudeai'], env: loginEnv, signal: abort.signal, ...(spawnImpl ? { spawnImpl } : {}) });
    } finally { if (profile) await closeClaudeLoginTabs(tabs); }
    if (callbackFailure) throw callbackFailure;
    if (launched?.status !== 0 || launched?.signal) throw new Error('Claude native login was cancelled or failed.');
    const staged = readManagedClaudeNativeBundleFromFiles({ descriptor });
    if (!staged.ok || !staged.nativeClaudeBundle.oauthAccount.organizationUuid) throw new Error('Claude native login did not produce a complete verified account and organization.');
    const identity = staged.nativeClaudeBundle.oauthAccount;
    await ensureClaudeAccountMetadata(runtime.store, { label, identity, policy: metadata.policy });
    metadata = { ...metadata, identity };
    await saveLocalClaudeLogin({ homeDir, label, metadata, environment: runtime.environment, command,
      nativeClaudeBundle: staged.nativeClaudeBundle,
      ...(context.assertClaudeNativeOwnersStoppedImpl ? { assertStopped: context.assertClaudeNativeOwnersStoppedImpl } : {}) });
    writeJsonFileIfChanged(path.join(homeDir,'.aimgr','claude-account-metadata.json'), {schema:1,environmentBinding:runtime.environment.binding,credentials:[...runtime.snapshot.credentials.filter(item=>item.label!==label),{...metadata,credential:{}}]}, {mode:0o600});
    if (manual || opts.json) emit({ type: 'result', ok: true, label, provider: 'anthropic', authority: 'environment-local' });
    else stdout.write(`Claude ${label} is signed in on this machine.\n`);
  } catch (error) {
    if (!manual) throw error;
    emit({ type: 'error', ok: false, label, provider: 'anthropic', error: 'Claude local login failed.' });
    context.setExitCode(1);
  } finally {
    if (interval) clearInterval(interval); if (timeout) clearTimeout(timeout);
    input?.removeAllListeners(); input?.close();
    if (stagingHome) fs.rmSync(stagingHome, { recursive: true, force: true });
    if (runtime) await closeRedisRuntime(runtime);
  }
}
