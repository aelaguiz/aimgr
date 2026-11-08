import { acquireClaudeAssignmentLock } from '../network/claude-offline-binding.js';
import { readLocalClaudeCredential, markLocalClaudeGrantRejected } from './claude-local.js';
import { resolveNativeAccountProfile } from '../network/claude-native-route.js';
import { runClaudeCliNoninteractive } from '../targets/claude-runner.js';

// Native refreshes its own local grant under its own refresh lock. AIM never
// projects a token before this request or publishes the resulting rotation.
export async function maintainLocalClaudeCredential(context, { metadata, environment, state, force = false }) {
  const { homeDir, label = metadata.label } = context;
  const options = { homeDir, label, metadata, environment };
  const guard = await acquireClaudeAssignmentLock(homeDir, label, { waitForTransition: true });
  try {
    const before = readLocalClaudeCredential(options);
    if (!before.credential) return { outcome: before.status === 'reauth_required' ? 'reauth_required' : 'skipped', reason: before.status };
    if (!force && before.credential.expiresAt && Date.parse(before.credential.expiresAt) > Date.now() + 5 * 60_000) return { outcome: 'unchanged', reason: 'not_due' };
    const profile = resolveNativeAccountProfile({homeDir,state,label});
    const result = await (context.runClaudeCliNoninteractiveImpl ?? runClaudeCliNoninteractive)({
      command: context.resolveExecutableOnPathImpl?.('claude'), userHomeDir: homeDir,
      homeDir: before.claudeHome, configDir: before.configDir, cwd: process.cwd(), env: context.env,
      args: ['--safe-mode','--strict-mcp-config','--no-session-persistence','--print','--output-format','json','/usage'],
      timeoutMs: 30_000, assignmentLock: guard, egressProfile: profile, expectedIdentity: before.nativeClaudeBundle.oauthAccount });
    guard.assertOwned();
    const after = readLocalClaudeCredential(options);
    if (after.owner?.grant?.id !== before.owner.grant.id) return {outcome:'retryable',reason:'local_login_changed'};
    const explicitlyRejected = /(?:invalid_grant|invalid refresh token|refresh token (?:has )?(?:expired|revoked)|login expired)/i.test(`${result?.stdout ?? ''} ${result?.stderr ?? ''}`);
    if (explicitlyRejected || after.status === 'reauth_required') {
      await markLocalClaudeGrantRejected({...options,grantId:before.owner.grant.id,generation:before.generation});
      return {outcome:'reauth_required',reason:'local_grant_rejected'};
    }
    if (!after.credential) return { outcome: after.status === 'reauth_required' ? 'reauth_required' : 'retryable', reason: after.status };
    if (result?.status !== 0 || result?.signal || result?.timedOut) return {outcome:'retryable',reason:'native_maintenance_failed'};
    return {outcome:before.generation !== after.generation ? 'refreshed' : 'unchanged',reason:before.generation !== after.generation ? 'credential_rotated' : 'tokens_unchanged'};
  } catch { return {outcome:'retryable',reason:'local_maintenance_unavailable'}; }
  finally { await guard.release(); }
}
