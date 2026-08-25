import { resolveTailscaleIpv4 } from "../../mcp/machine-info.js";
import { AIM_MCP_DEFAULT_PORT, startHttpServer, startStdio } from "../../mcp/server.js";

function parsePort(rawPort) {
  if (rawPort === undefined) return AIM_MCP_DEFAULT_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port requires a TCP port between 1 and 65535 (got ${rawPort}).`);
  }
  return port;
}

export async function handleMcp(context) {
  const { positional, opts, stdout, env, homeDir } = context;
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
    return startStdio({ homeDir, env });
  }

  const port = parsePort(opts.port);
  // The tailnet address is the intended surface: reachable from Amir's other
  // machines and phone, unreachable from the public internet.
  const bind = opts.bind ?? resolveTailscaleIpv4() ?? "0.0.0.0";
  const served = await startHttpServer({ port, bind, homeDir, env });
  stdout.write(
    `aim mcp serve listening on http://${bind}:${served.port}/mcp (unauthenticated; tailnet-only by intent)\n`,
  );
  return served;
}
