import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { ClaudeRouteError } from "../network/claude-egress-policy.js";
import { checkClaudeRouteExit } from "../network/claude-transport.js";

const exec = promisify(execFile);

export async function connectCdp(url, { timeoutMs = 8000 } = {}) {
  const socket = new WebSocket(url);
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`Chrome CDP ${request.method} failed`));
    else request.resolve(message.result);
  });
  const rejectPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Chrome CDP connection closed"));
    }
    pending.clear();
  };
  socket.on("close", rejectPending);
  socket.on("error", rejectPending);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Chrome CDP timed out")); }, timeoutMs);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", () => { clearTimeout(timer); reject(new Error("Chrome CDP unavailable")); });
  });
  return {
    call(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome CDP ${method} timed out`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
          if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      });
    },
    close() { socket.close(); },
  };
}

// R1/R5: use the already configured local account Chrome. Failure must not
// fall back to the default browser, launch a replacement, or copy its cookies.
// Chrome honoring its validated fixed proxy is the agreed trust boundary;
// adding another browser firewall or changing its fingerprint is out of scope.
// Regression: test/network/claude-chrome.test.js.
export function readClaudeChromeDebuggingPort(args) {
  const values = args.filter(value => value.startsWith("--remote-debugging-port="));
  if (values.length !== 1) return null;
  // ps joins a following positional startup URL into this flag's chunk.
  // The numeric value ends at whitespace; path-valued flags retain spaces.
  return values[0].match(/^--remote-debugging-port=(\d+)(?:\s|$)/)?.[1] ?? null;
}

export async function validateClaudeChrome(profile) {
  const chrome = profile.chrome;
  const reject = (field) => { throw new ClaudeRouteError("chrome_binding_mismatch", { ...profile, cause: new Error(field ?? "configuration") }); };
  if (!Number.isInteger(chrome?.cdpPort) || chrome.cdpPort < 1 || chrome.cdpPort > 65535
      || !path.isAbsolute(chrome?.userDataDir ?? "")) reject();
  const expectedProxy = `socks5://${profile.socksHost === "::1" ? "[::1]" : profile.socksHost}:${profile.socksPort}`;
  const prefs = JSON.parse(await fs.readFile(path.join(chrome.userDataDir, "Default", "Preferences"), "utf8"));
  if (prefs.proxy?.mode !== "fixed_servers" || prefs.proxy?.server !== expectedProxy
      || (prefs.proxy?.bypass_list ?? "") !== "") reject();
  // Verify that this local CDP listener belongs to the configured profile. CDP
  // control alone does not identify an account, and ports can be configured wrong.
  const { stdout } = await exec("lsof", ["-nP", "-t", `-iTCP:${chrome.cdpPort}`, "-sTCP:LISTEN"]);
  const pids = [...new Set(stdout.trim().split(/\s+/))];
  if (pids.length !== 1 || !/^\d+$/.test(pids[0])) reject();
  let args;
  if (process.platform === "linux") {
    args = (await fs.readFile(`/proc/${pids[0]}/cmdline`, "utf8")).split("\0").filter(Boolean);
    // Chrome may replace argv with one process-title string on Linux.
    if (args.length === 1) args = args[0].trim().split(/\s+(?=--)/);
  } else {
    const result = await exec("ps", ["-ww", "-p", pids[0], "-o", "command="]);
    // ps preserves spaces in Chrome's data directory; split on flag boundaries.
    args = result.stdout.trim().split(/\s+(?=--)/);
  }
  const argument = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (argument("user-data-dir") !== chrome.userDataDir) reject("user-data-dir");
  if (readClaudeChromeDebuggingPort(args) !== String(chrome.cdpPort)) reject("remote-debugging-port");
  if (argument("proxy-server") && argument("proxy-server") !== expectedProxy) reject("proxy-server");
  await checkClaudeRouteExit(profile);
  const response = await fetch(`http://127.0.0.1:${chrome.cdpPort}/json/version`, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!response.ok) reject();
  const version = await response.json();
  const endpoint = new URL(version.webSocketDebuggerUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      || endpoint.protocol !== "ws:" || endpoint.port !== String(chrome.cdpPort)) reject();
  return { webSocketDebuggerUrl: endpoint.href, version: version.Browser };
}

export async function openClaudeLoginInChrome(profile, url, { receiptPath } = {}) {
  const destination = new URL(url);
  // Claude supplies the sign-in URL. Its OAuth entry point can move between
  // domains; routing belongs to the account's Chrome, not a host allowlist.
  if (destination.protocol !== "https:") {
    throw new ClaudeRouteError("invalid_login_url", profile);
  }
  // Login validated before starting native staging; validate again now because
  // its OAuth URL can arrive later, after a browser/tunnel binding has changed.
  const validated = await validateClaudeChrome(profile);
  const cdp = await connectCdp(validated.webSocketDebuggerUrl);
  try {
    // This is the site's own persisted "Reject all cookies" preference,
    // verified against its privacy dialog. Set it before the first sign-in
    // request; preserve authentication cookies and the existing browser state.
    await cdp.call("Storage.setCookies", { cookies: [{
      name: "anthropic-consent-preferences",
      value: encodeURIComponent(JSON.stringify({ analytics: false, marketing: false })),
      domain: ".claude.ai", path: "/", secure: true, httpOnly: false,
      sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 365 * 86400,
    }] });
    // A tab in the existing account instance preserves its cookies and SSO state.
    // Never create this target at the OAuth URL. Consent must already be set,
    // and cleanup ownership recorded before the first account-bearing navigation.
    // The fixture checks first-request consent and zero origin requests on denial.
    const target = await cdp.call("Target.createTarget", { url: "about:blank" });
    try {
      if (receiptPath) await fs.appendFile(receiptPath, JSON.stringify({ endpoint: validated.webSocketDebuggerUrl, targetId: target.targetId }) + "\n", { mode: 0o600 });
      const { sessionId } = await cdp.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const navigation = await cdp.call("Page.navigate", { url: destination.href }, sessionId);
      if (navigation.errorText) throw new ClaudeRouteError("proxy_unavailable", profile);
      return target;
    } catch (error) {
      await cdp.call("Target.closeTarget", { targetId: target.targetId });
      throw error;
    }
  } finally { cdp.close(); }
}


// Close only tabs created by this managed login. Existing account tabs and
// persistent Chrome profiles remain untouched, including during an outage.
export async function closeClaudeLoginTabs(receiptPath) {
  let contents;
  try { contents = await fs.readFile(receiptPath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const line of contents.trim().split("\n").filter(Boolean)) {
    const { endpoint, targetId } = JSON.parse(line);
    const cdp = await connectCdp(endpoint);
    try {
      await cdp.call("Target.closeTarget", { targetId });
      // Chrome acknowledges close before the target is actually destroyed.
      const deadline = Date.now() + 8000;
      while ((await cdp.call("Target.getTargets")).targetInfos.some((target) => target.targetId === targetId)) {
        if (Date.now() >= deadline) throw new Error("Claude login tab did not close");
        await delay(50);
      }
    } finally { cdp.close(); }
  }
  await fs.unlink(receiptPath);
}
