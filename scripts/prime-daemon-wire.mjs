#!/usr/bin/env node
// Send one raw command to the Prime Agent supervisor over its JSONL socket.
//
//   node scripts/prime-daemon-wire.mjs hello              print daemon_hello (pid, generation, build)
//   node scripts/prime-daemon-wire.mjs list               list resident sessions
//   node scripts/prime-daemon-wire.mjs restart            worker-PRESERVING supervisor restart (fork removed the CLI for this)
//   node scripts/prime-daemon-wire.mjs shutdown [--force] stop supervisor AND every worker (same as `prime-agent shutdown`)
//
// Options: --socket <path>  --timeout-ms <n> (default 30000)
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const verb = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const socketPath = opt("--socket", join(tmpdir(), `prime-agent-${userInfo().uid}`, "daemon.sock"));
const timeoutMs = Number(opt("--timeout-ms", "30000"));
if (!verb || !["hello", "list", "restart", "shutdown"].includes(verb)) {
  console.error("usage: prime-daemon-wire.mjs hello|list|restart|shutdown [--force] [--socket <path>]");
  process.exit(2);
}

const command =
  verb === "list"
    ? { id: randomUUID(), type: "list" }
    : verb === "restart"
      ? { id: randomUUID(), type: "restart" }
      : verb === "shutdown"
        ? { id: randomUUID(), type: "shutdown", force: args.includes("--force") }
        : undefined;

const socket = connect(socketPath);
let buffer = "";
let helloSeen = false;
const timer = setTimeout(() => {
  console.error(`timed out after ${timeoutMs} ms (hello seen: ${helloSeen})`);
  process.exit(1);
}, timeoutMs);

socket.on("error", (error) => {
  console.error(`connect failed: ${error.message}`);
  process.exit(1);
});
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "daemon_hello") {
      helloSeen = true;
      console.log(
        JSON.stringify(
          {
            pid: msg.supervisorPid,
            generation: msg.supervisorGeneration,
            appVersion: msg.appVersion,
            protocol: msg.protocol,
            schemaId: msg.schemaId,
            buildId: msg.runtime?.buildId,
            entrypoint: msg.runtime?.entrypointPath,
          },
          null,
          2,
        ),
      );
      if (!command) {
        clearTimeout(timer);
        socket.end();
        process.exit(0);
      }
      const envelope = {
        type: "command",
        id: randomUUID(),
        protocol: { name: "prime-agent.daemon", version: Math.min(msg.protocol?.version ?? 7, 7) },
        clientId: `aimgr-wire-${process.pid}`,
        command,
      };
      socket.write(`${JSON.stringify(envelope)}\n`);
      continue;
    }
    if (msg.type === "response" && msg.command === command?.type) {
      clearTimeout(timer);
      if (msg.success) {
        const data = msg.data;
        if (verb === "list" && Array.isArray(data?.sessions ?? data)) {
          const rows = data.sessions ?? data;
          for (const row of rows) {
            console.log(
              `${row.activeSessionId ?? row.id ?? "?"}  ${row.sessionId ?? row.session?.id ?? ""}  ${row.state ?? row.workerState ?? ""}  ${row.name ?? ""}`,
            );
          }
          console.log(`${rows.length} resident session(s)`);
        } else {
          console.log(`${verb}: accepted${data ? ` ${JSON.stringify(data).slice(0, 400)}` : ""}`);
        }
        socket.end();
        process.exit(0);
      }
      console.error(`${verb}: refused: ${msg.error}`);
      socket.end();
      process.exit(1);
    }
  }
});
