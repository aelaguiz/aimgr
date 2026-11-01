import net from "node:net";
import tls from "node:tls";
import { Agent, fetch } from "undici";
import { SocksClient } from "socks";
import { ClaudeRouteError, resolveClaudeEgressProfile } from "./claude-egress-policy.js";

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

// Keep a local SOCKS greeting open for the operation's lifetime. Tunnel exit
// closes it even when no model request is active, so a quick SSH restart cannot
// revive an interrupted operation. No account data is sent on this connection.
function watchSocksListener(profile, timeoutMs, onFailure) {
  const socket = net.connect({ host: profile.socksHost, port: profile.socksPort });
  let stopped = false;
  const ready = new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const failed = (error) => {
      if (stopped) return;
      const failure = onFailure(error);
      reject(failure);
      socket.destroy();
    };
    socket.setTimeout(timeoutMs, () => failed(new Error("SOCKS greeting timed out")));
    socket.on("error", failed);
    socket.once("close", () => failed(new Error("SOCKS listener closed")));
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 2) return;
      if (received[0] !== 5 || received[1] !== 0) failed(new Error("SOCKS greeting rejected"));
      else { socket.setTimeout(0); resolve(); }
    });
  });
  return { ready, close() { stopped = true; socket.destroy(); } };
}

export async function checkClaudeRouteExit(profile, { timeoutMs = 8000, signal } = {}) {
  signal?.throwIfAborted();
  const probe = createClaudeTransport(profile, { timeoutMs, isProbe: true });
  try {
    const deadline = AbortSignal.timeout(timeoutMs);
    const response = await probe.fetch(profile.exitCheckUrl ?? "https://api.ipify.org?format=json", { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: "error" });
    const address = response.ok ? (await response.json()).ip : null;
    if (!profile.expectedExits?.includes(address)) throw new ClaudeRouteError("proxy_exit_mismatch", profile);
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    throw cause instanceof ClaudeRouteError ? cause : new ClaudeRouteError("proxy_unavailable", { ...profile, cause });
  } finally { await probe.close(); }
}

export function createClaudeTransport(profile, { timeoutMs = 8000, healthIntervalMs = 5000, onFailure = () => {}, isProbe = false, checkRouteExitImpl = checkClaudeRouteExit } = {}) {
  let terminalError = null;
  let disposed = false;
  let ready = null;
  let watcher = null;
  let healthTimer = null;
  const requests = new AbortController();
  const fail = (cause) => {
    if (!terminalError) {
      terminalError = cause instanceof ClaudeRouteError ? cause
        : new ClaudeRouteError("proxy_unavailable", { ...profile, cause });
      clearTimeout(healthTimer);
      requests.abort(terminalError);
      void dispatcher.destroy(terminalError);
      onFailure(terminalError);
    }
    return terminalError;
  };
  const dispatcher = new Agent({
    connect(options, callback) {
      if (terminalError || disposed) {
        callback(terminalError ?? new ClaudeRouteError("operation_closed", profile));
        return;
      }
      // Passing the hostname to SOCKS5 makes the SSH exit perform DNS lookup.
      SocksClient.createConnection({
        proxy: { host: profile.socksHost, port: profile.socksPort, type: 5 },
        command: "connect",
        destination: {
          host: options.hostname.replace(/^\[|\]$/g, ""),
          // Undici passes an empty string for the URL's default port.
          port: options.port ? Number(options.port) : options.protocol === "https:" ? 443 : 80,
        },
        timeout: timeoutMs,
      }).then(({ socket }) => {
        if (terminalError || disposed) {
          socket.destroy();
          callback(terminalError ?? new ClaudeRouteError("operation_closed", profile));
          return;
        }
        if (options.protocol === "http:") {
          callback(null, socket);
          return;
        }
        const hostname = options.hostname.replace(/^\[|\]$/g, "");
        const secured = tls.connect({
          socket,
          host: hostname,
          servername: net.isIP(hostname) ? undefined : hostname,
          rejectUnauthorized: true,
          ALPNProtocols: ["http/1.1"],
        });
        const timer = setTimeout(() => secured.destroy(new Error("TLS connection timed out")), timeoutMs);
        const onError = (error) => { clearTimeout(timer); callback(error); };
        secured.once("error", onError);
        secured.once("secureConnect", () => {
          clearTimeout(timer);
          secured.removeListener("error", onError);
          callback(null, secured);
        });
      }, (error) => {
        // OpenSSH also closes the SOCKS channel when only the destination is
        // unavailable. The fetch error path checks route health before deciding
        // whether to stop this operation; the listener watcher catches SSH exit.
        callback(error);
      });
    },
  });
  const scheduleHealthCheck = () => {
    if (disposed || terminalError || isProbe) return;
    healthTimer = setTimeout(async () => {
      try { await checkRouteExitImpl(profile, { timeoutMs, signal: requests.signal }); }
      catch (error) { if (!disposed) fail(error); }
      scheduleHealthCheck();
    }, healthIntervalMs);
    healthTimer.unref();
  };
  const classifyFailure = async (error) => {
    if (terminalError) return terminalError;
    if (isProbe) return error;
    try { await checkRouteExitImpl(profile, { timeoutMs, signal: requests.signal }); }
    catch (routeError) { return fail(routeError); }
    return error;
  };
  return {
    profile,
    get failure() { return terminalError; },
    async check() {
      if (terminalError) throw terminalError;
      if (disposed) throw new ClaudeRouteError("operation_closed", profile);
      try { await checkRouteExitImpl(profile, { timeoutMs, signal: requests.signal }); }
      catch (error) { throw fail(error); }
    },
    async fetch(input, init = {}) {
      if (terminalError) throw terminalError;
      if (disposed) throw new ClaudeRouteError("operation_closed", profile);
      const callerSignal = init.signal ?? input?.signal;
      const signal = callerSignal ? AbortSignal.any([callerSignal, requests.signal]) : requests.signal;
      signal.throwIfAborted();
      try {
        if (!isProbe) {
          ready ??= (async () => {
            watcher = watchSocksListener(profile, timeoutMs, fail);
            await watcher.ready;
            await checkRouteExitImpl(profile, { timeoutMs, signal: requests.signal });
            scheduleHealthCheck();
          })().catch((error) => { throw fail(error); });
          await waitWithSignal(ready, signal);
        }
        const response = await fetch(input, {
          ...init,
          dispatcher,
          signal,
        });
        if (!response.body || isProbe) return response;
        const reader = response.body.getReader();
        const body = new ReadableStream({
          async pull(controller) {
            try {
              const item = await reader.read();
              if (item.done) controller.close();
              else controller.enqueue(item.value);
            } catch (error) {
              try { controller.error(callerSignal?.aborted ? error : await waitWithSignal(classifyFailure(error), signal)); }
              catch (failure) { controller.error(failure); }
            }
          },
          cancel(reason) { return reader.cancel(reason); },
        });
        const guarded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        for (const key of ["url", "redirected", "type"]) Object.defineProperty(guarded, key, { value: response[key] });
        return guarded;
      } catch (error) {
        if (terminalError) throw terminalError;
        if (callerSignal?.aborted) throw error;
        throw await waitWithSignal(classifyFailure(error), signal);
      }
    },
    fail,
    async close() {
      disposed = true;
      clearTimeout(healthTimer);
      watcher?.close();
      requests.abort();
      await dispatcher.destroy();
    },
  };
}

// Resolve account and route together; callers cannot supply a token/dispatcher pair.
export function createClaudeAccountTransport({ label, state, profiles, ...options }) {
  const account = state?.accounts?.[label];
  if (account?.provider !== "anthropic") throw new ClaudeRouteError("invalid_account", { label });
  const profile = resolveClaudeEgressProfile({ label, account, profiles });
  const credential = structuredClone(state?.credentials?.anthropic?.[label] ?? {});
  const transport = createClaudeTransport(profile, options);
  return Object.assign(transport, { credential });
}
