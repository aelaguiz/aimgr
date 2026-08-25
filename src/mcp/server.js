// MCP surface for aimgr: three tools over Streamable HTTP or stdio. The HTTP lane
// is stateless — one MCP server plus one transport per POST — so a dropped client
// leaves nothing behind. There is no auth here by design; see README and the plan:
// the tailnet is the trust boundary, and this exposes exactly the authority ssh
// already grants.

import http from "node:http";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { runAimCommand, AIM_MCP_DEFAULT_TIMEOUT_MS } from "./exec.js";
import { collectMachineInfo } from "./machine-info.js";
import { AIM_MCP_DEFAULT_TAIL_LINES, AIM_MCP_MAX_TAIL_LINES, tailLog } from "./logs.js";
import { validateAimArgv } from "./policy.js";

export const AIM_MCP_DEFAULT_PORT = 7337;
export const AIM_MCP_HTTP_PATH = "/mcp";
const MAX_REQUEST_BODY_BYTES = 4_194_304;

const AIM_EXEC_DESCRIPTION = [
  "Run one non-interactive `aim` command on this machine and return its raw output.",
  "This is the whole aimgr CLI: reads and actions. Common invocations:",
  '["status","--json"], ["claude","status","--json"], ["grok","status","--json"],',
  '["claude","list","--json"], ["codex","use"], ["auth","maintain"],',
  '["routine","run","<id>","--manual"].',
  'Run ["help"] to print the full command surface, including flags.',
  'Prefer ["status","--compact"] or a scoped read such as ["claude","status","--json"] or',
  '["grok","status","--json"] first: ["status","--json"] returns roughly 200k characters.',
  "Interactive lanes are rejected with the reason: login, credential-helper,",
  "claude/prime run|resume, and codex/hermes watch without --once.",
  "Returns {ok, exitCode, signal, durationMs, stdout, stderr, truncated}; stdout is",
  "the command's exact text, so pass --json when you want structured data.",
].join(" ");

const AIM_MACHINE_INFO_DESCRIPTION = [
  "Facts about this machine that no `aim` command prints: hostname, Tailscale IPv4,",
  "aimgr git rev, disk free for $HOME, `aim redis ping` duration, mtime and age of the",
  "auth-maintainer / codex-watch / hermes-watch / mcp-serve logs, and the newest",
  "routine receipt per routine id. Facts only — no health grade or verdict.",
].join(" ");

const AIM_LOG_TAIL_DESCRIPTION = [
  "Tail a known aimgr log by name (auth-maintainer, codex-watch, hermes-watch,",
  "mcp-serve) or an explicit absolute path. A name returns both the .out and .err",
  `tails. Default ${AIM_MCP_DEFAULT_TAIL_LINES} lines, capped at ${AIM_MCP_MAX_TAIL_LINES}.`,
  "A missing file returns present:false rather than an error.",
].join(" ");

function textResult(payload, { isError = false } = {}) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
  };
}

function errorResult(message) {
  return textResult({ ok: false, error: message }, { isError: true });
}

function defaultLog(line) {
  process.stdout.write(`${line}\n`);
}

function summarizeArgv(argv) {
  return argv.map(String).join(" ").slice(0, 200);
}

export function buildMcpServer({
  homeDir = os.homedir(),
  env = process.env,
  runAimCommandImpl = runAimCommand,
  collectMachineInfoImpl = collectMachineInfo,
  tailLogImpl = tailLog,
  logImpl = defaultLog,
  nowImpl = Date.now,
} = {}) {
  const server = new McpServer({ name: "aimgr", version: "1" });

  server.registerTool(
    "aim_exec",
    {
      title: "Run an aim command",
      description: AIM_EXEC_DESCRIPTION,
      inputSchema: {
        argv: z.array(z.string()).describe('Argument vector without the leading "aim", e.g. ["status","--json"].'),
        timeoutSec: z.number().int().min(1).max(900).optional()
          .describe("Kill the command after this many seconds (default 120)."),
      },
    },
    async ({ argv, timeoutSec }) => {
      const startedAt = nowImpl();
      const verdict = validateAimArgv(argv);
      if (!verdict.ok) {
        logImpl(`aim mcp tool=aim_exec argv="${summarizeArgv(argv ?? [])}" rejected=policy`);
        return errorResult(verdict.reason);
      }
      const result = await runAimCommandImpl(argv, {
        timeoutMs: timeoutSec === undefined ? AIM_MCP_DEFAULT_TIMEOUT_MS : timeoutSec * 1000,
        env,
      });
      logImpl(
        `aim mcp tool=aim_exec argv="${summarizeArgv(argv)}" ms=${nowImpl() - startedAt} ok=${result.ok}`,
      );
      return textResult({ argv, ...result }, { isError: !result.ok });
    },
  );

  server.registerTool(
    "aim_machine_info",
    {
      title: "This machine's aimgr facts",
      description: AIM_MACHINE_INFO_DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      const startedAt = nowImpl();
      try {
        const info = await collectMachineInfoImpl({ homeDir });
        logImpl(`aim mcp tool=aim_machine_info ms=${nowImpl() - startedAt} ok=true`);
        return textResult(info);
      } catch (error) {
        logImpl(`aim mcp tool=aim_machine_info ms=${nowImpl() - startedAt} ok=false`);
        return errorResult(String(error?.message ?? error));
      }
    },
  );

  server.registerTool(
    "aim_log_tail",
    {
      title: "Tail an aimgr log",
      description: AIM_LOG_TAIL_DESCRIPTION,
      inputSchema: {
        name: z.enum(["auth-maintainer", "codex-watch", "hermes-watch", "mcp-serve"]).optional()
          .describe("Known log name; returns both the .out and .err tails."),
        path: z.string().optional().describe("Absolute path to any other log file."),
        lines: z.number().int().min(1).max(AIM_MCP_MAX_TAIL_LINES).optional()
          .describe(`Lines per file (default ${AIM_MCP_DEFAULT_TAIL_LINES}).`),
      },
    },
    async ({ name, path: logPath, lines }) => {
      const startedAt = nowImpl();
      try {
        const tail = tailLogImpl({ name, path: logPath, lines }, { homeDir });
        logImpl(`aim mcp tool=aim_log_tail target=${name ?? logPath} ms=${nowImpl() - startedAt} ok=true`);
        return textResult(tail);
      } catch (error) {
        logImpl(`aim mcp tool=aim_log_tail target=${name ?? logPath} ms=${nowImpl() - startedAt} ok=false`);
        return errorResult(String(error?.message ?? error));
      }
    },
  );

  return server;
}

function writeJson(res, status, payload, onFinish) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body, onFinish);
}

function jsonRpcError(code, message) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        // Stop reading, but leave the socket alive: the caller still owes this
        // client an error response before the connection goes away.
        req.pause();
        const error = new Error("Request body too large.");
        error.oversized = true;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleMcpPost(req, res, deps) {
  let parsedBody;
  try {
    const raw = await readRequestBody(req);
    parsedBody = raw ? JSON.parse(raw) : undefined;
  } catch (error) {
    // The response is written first; an oversized body only then loses its socket,
    // so the client reads the reason instead of a bare connection reset.
    writeJson(
      res,
      400,
      jsonRpcError(-32700, `Parse error: ${String(error?.message ?? error)}`),
      error?.oversized ? () => req.socket?.destroy() : undefined,
    );
    return;
  }
  // Stateless: a fresh server and transport per request, torn down when the
  // response closes. No session table, so a vanished client leaks nothing.
  const server = buildMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export function startHttpServer({
  port = AIM_MCP_DEFAULT_PORT,
  bind = "0.0.0.0",
  createServerImpl = http.createServer,
  ...deps
} = {}) {
  const httpServer = createServerImpl((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== AIM_MCP_HTTP_PATH) {
      writeJson(res, 404, jsonRpcError(-32601, `Not found: ${pathname}. The MCP endpoint is ${AIM_MCP_HTTP_PATH}.`));
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, jsonRpcError(-32000, `Method not allowed: ${req.method}. POST JSON-RPC to ${AIM_MCP_HTTP_PATH}.`));
      return;
    }
    handleMcpPost(req, res, deps).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      writeJson(res, 500, jsonRpcError(-32603, `Internal error: ${String(error?.message ?? error)}`));
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, bind, () => {
      httpServer.removeListener("error", reject);
      const address = httpServer.address();
      resolve({
        httpServer,
        port: typeof address === "object" && address ? address.port : port,
        bind,
        close: () => new Promise((done) => httpServer.close(() => done())),
      });
    });
  });
}

export async function startStdio(deps = {}) {
  const server = buildMcpServer({ ...deps, logImpl: deps.logImpl ?? (() => {}) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}
