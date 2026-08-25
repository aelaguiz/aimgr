import { sleep } from "../../io/streams.js";
import { resolveTailscaleIpv4 } from "../../mcp/machine-info.js";
import { AIM_MCP_DEFAULT_PORT, startHttpServer, startStdio } from "../../mcp/server.js";

export const TAILSCALE_WAIT_INTERVAL_MS = 5_000;
export const TAILSCALE_WAIT_LOG_INTERVAL_MS = 30_000;

// The LaunchAgent starts at login, often before tailscaled has an address. Binding
// 0.0.0.0 in that window would expose this unauthenticated server on every
// interface, so the default lane waits for the tailnet address instead.
async function waitForTailscaleIpv4({ resolveImpl, sleepImpl, stdout }) {
  let waitedMs = 0;
  for (;;) {
    const address = resolveImpl();
    if (address) return address;
    if (waitedMs % TAILSCALE_WAIT_LOG_INTERVAL_MS === 0) {
      stdout.write(
        `aim mcp serve: waiting for this machine's Tailscale IPv4 before binding (${waitedMs / 1000}s elapsed; pass --bind to skip)\n`,
      );
    }
    await sleepImpl(TAILSCALE_WAIT_INTERVAL_MS);
    waitedMs += TAILSCALE_WAIT_INTERVAL_MS;
  }
}

function parsePort(rawPort) {
  if (rawPort === undefined) return AIM_MCP_DEFAULT_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port requires a TCP port between 1 and 65535 (got ${rawPort}).`);
  }
  return port;
}

export async function handleMcp(context) {
  const {
    positional,
    opts,
    stdout,
    env,
    homeDir,
    resolveTailscaleIpv4Impl = resolveTailscaleIpv4,
    sleepImpl = sleep,
    startHttpServerImpl = startHttpServer,
    startStdioImpl = startStdio,
  } = context;
  const subcommand = positional[1];
  if (subcommand !== "serve") {
    throw new Error(
      `Unknown mcp subcommand: ${subcommand ?? "(none)"}. Usage: aim mcp serve [--port <n>] [--bind <ip>] [--stdio].`,
    );
  }
  if (opts.stdio && (opts.port !== undefined || opts.bind !== undefined)) {
    throw new Error("--stdio serves one client over stdin/stdout; it cannot be combined with --port or --bind.");
  }

  if (opts.stdio) {
    return startStdioImpl({ homeDir, env });
  }

  const port = parsePort(opts.port);
  // The tailnet address is the intended surface: reachable from Amir's other
  // machines and phone, unreachable from the public internet. An explicit --bind
  // (including 0.0.0.0) is the operator's call and skips the wait.
  const bind = opts.bind
    ?? await waitForTailscaleIpv4({ resolveImpl: resolveTailscaleIpv4Impl, sleepImpl, stdout });
  const served = await startHttpServerImpl({ port, bind, homeDir, env });
  stdout.write(
    `aim mcp serve listening on http://${bind}:${served.port}/mcp (unauthenticated; tailnet-only by intent)\n`,
  );
  return served;
}
