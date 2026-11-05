import { connectCdp, validateAccountChrome } from "./claude-cdp.js";
import { CodexRouteError, checkCodexRouteExit } from "../network/codex-egress.js";
import { resolveEgressProfile } from "../network/claude-egress-policy.js";

// The original browser host needs SOCKS and CDP only. The headless CLI host
// separately validates its native HTTP inbound; it is not a browser prerequisite.
export const resolveCodexBrowserProfile = options => Object.freeze({
  ...resolveEgressProfile({ ...options, account: { egress: options.egress }, RouteError: CodexRouteError }),
  exitCheckUrl: "https://1.1.1.1/cdn-cgi/trace", exitCheckFormat: "cloudflare-trace",
});

export const validateCodexChrome = profile => validateAccountChrome(profile,
  { RouteError: CodexRouteError, checkRouteExitImpl: checkCodexRouteExit });

/** Open only a tab in the original validated profile; no cookie/fingerprint
 * edits, replacement browser or profile copying are involved. */
export async function openCodexLoginInChrome(profile, url) {
  const destination = new URL(url);
  if (destination.origin !== "https://auth.openai.com" || destination.pathname !== "/oauth/authorize"
    || destination.username || destination.password || destination.hash) throw new CodexRouteError("invalid_login_url", profile);
  const validated = await validateCodexChrome(profile);
  const cdp = await connectCdp(validated.webSocketDebuggerUrl);
  let target;
  try {
    target = await cdp.call("Target.createTarget", { url: "about:blank", background: true });
    const { sessionId } = await cdp.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const navigation = await cdp.call("Page.navigate", { url: destination.href }, sessionId);
    if (navigation.errorText) throw new CodexRouteError("proxy_unavailable", profile);
    return { async close() {
      const connection = await connectCdp(validated.webSocketDebuggerUrl);
      try { await connection.call("Target.closeTarget", { targetId: target.targetId }); }
      finally { connection.close(); }
    } };
  } catch (error) {
    if (target) await cdp.call("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
    throw error;
  } finally { cdp.close(); }
}
