import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/args.js";
import { handleMcp, TAILSCALE_WAIT_INTERVAL_MS } from "../../src/cli/commands/mcp.js";
import { runCli } from "../helpers/cli-runner.js";

function makeContext(argv, overrides = {}) {
  const { opts, positional } = parseArgs(argv);
  const written = [];
  return {
    context: {
      opts,
      positional,
      env: {},
      homeDir: "/tmp/aim-mcp-home",
      stdout: { write: (chunk) => written.push(chunk) },
      startStdioImpl: async () => ({ lane: "stdio" }),
      startHttpServerImpl: async ({ port, bind }) => ({ port, bind, close: async () => {} }),
      resolveTailscaleIpv4Impl: () => "100.72.74.74",
      sleepImpl: async () => {},
      ...overrides,
    },
    written,
  };
}

test("aim mcp rejects a bad subcommand and an out-of-range port", async () => {
  await assert.rejects(
    handleMcp(makeContext(["mcp"]).context),
    /Unknown mcp subcommand: \(none\).*aim mcp serve/s,
  );
  await assert.rejects(
    handleMcp(makeContext(["mcp", "status"]).context),
    /Unknown mcp subcommand: status/,
  );
  for (const badPort of ["0", "70000", "http"]) {
    await assert.rejects(
      handleMcp(makeContext(["mcp", "serve", "--port", badPort]).context),
      /--port requires a TCP port between 1 and 65535/,
    );
  }
});

test("--stdio cannot be combined with a listener flag", async () => {
  for (const argv of [["mcp", "serve", "--stdio", "--port", "7337"], ["mcp", "serve", "--stdio", "--bind", "127.0.0.1"]]) {
    await assert.rejects(handleMcp(makeContext(argv).context), /cannot be combined with --port or --bind/);
  }
  const stdio = makeContext(["mcp", "serve", "--stdio"]);
  assert.deepEqual(await handleMcp(stdio.context), { lane: "stdio" });
  assert.deepEqual(stdio.written, []);
});

test("an explicit --bind is passed through without consulting tailscale", async () => {
  let resolverCalls = 0;
  const explicit = makeContext(["mcp", "serve", "--bind", "0.0.0.0", "--port", "7400"], {
    resolveTailscaleIpv4Impl: () => {
      resolverCalls += 1;
      return "100.72.74.74";
    },
  });

  const served = await handleMcp(explicit.context);

  assert.equal(served.bind, "0.0.0.0");
  assert.equal(served.port, 7_400);
  assert.equal(resolverCalls, 0);
  assert.match(explicit.written.join(""), /listening on http:\/\/0\.0\.0\.0:7400\/mcp \(unauthenticated/);
});

test("without --bind the server waits for the tailnet address instead of 0.0.0.0", async () => {
  const sleeps = [];
  const addresses = [null, null, "100.72.74.74"];
  const waiting = makeContext(["mcp", "serve"], {
    resolveTailscaleIpv4Impl: () => addresses.shift() ?? null,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });

  const served = await handleMcp(waiting.context);

  assert.equal(served.bind, "100.72.74.74");
  assert.equal(served.port, 7_337);
  assert.deepEqual(sleeps, [TAILSCALE_WAIT_INTERVAL_MS, TAILSCALE_WAIT_INTERVAL_MS]);
  // One waiting line at the start, then one per 30s — not one per retry.
  const waitLines = waiting.written.filter((line) => line.includes("waiting for this machine's Tailscale IPv4"));
  assert.equal(waitLines.length, 1);
  assert.match(waitLines[0], /pass --bind to skip/);
});

test("aim help prints the command surface instead of the label panel", async () => {
  const help = await runCli(["help"]);

  assert.match(help, /^aim — AI account manager/);
  assert.match(help, /aim mcp serve \[--port <n>\] \[--bind <ip>\] \[--stdio\]/);
  assert.equal(help, await runCli(["--help"]));
});
