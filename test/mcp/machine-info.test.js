import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  collectMachineInfo,
  parseDfKilobytes,
  readNewestRoutineReceipts,
  resolveTailscaleIpv4,
} from "../../src/mcp/machine-info.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

const DF_STDOUT = [
  "Filesystem 1024-blocks      Used Available Capacity iused ifree %iused  Mounted on",
  "/dev/disk3s5  1943276448 512000000 1200000000    30%  1234 5678   1%   /System/Volumes/Data",
].join("\n");

function fakeRunCommand(overrides = {}) {
  return (command) => {
    if (command in overrides) return overrides[command];
    if (command === "tailscale") return { ok: true, stdout: "100.96.80.106\n" };
    if (command === "git") return { ok: true, stdout: "abc1234\n" };
    if (command === "df") return { ok: true, stdout: DF_STDOUT };
    return { ok: false, error: `unexpected command: ${command}` };
  };
}

function fakeDeps(home, overrides = {}) {
  return {
    homeDir: home,
    nowMs: Date.UTC(2026, 7, 25, 12, 0, 0),
    repoRoot: "/repo",
    hostnameImpl: () => "amirs-mac-studio",
    networkInterfacesImpl: () => ({}),
    runCommandImpl: fakeRunCommand(),
    runAimCommandImpl: async () => ({ ok: true, exitCode: 0, durationMs: 41, stdout: "PONG", stderr: "", truncated: false }),
    logMap: {
      "codex-watch": {
        out: path.join(home, "codex-watch.out.log"),
        err: path.join(home, "codex-watch.err.log"),
      },
    },
    ...overrides,
  };
}

test("machine info returns facts and never a verdict", async () => {
  const home = mkTempHome();
  fs.writeFileSync(path.join(home, "codex-watch.out.log"), "watch line\n", "utf8");

  const info = await collectMachineInfo(fakeDeps(home));

  assert.deepEqual(Object.keys(info).sort(), [
    "aimgrRev",
    "collectedAt",
    "diskFree",
    "hostname",
    "logs",
    "redisPingMs",
    "repoRoot",
    "routineReceipts",
    "tailscaleIp",
  ]);
  assert.equal(info.hostname, "amirs-mac-studio");
  assert.equal(info.tailscaleIp, "100.96.80.106");
  assert.equal(info.aimgrRev, "abc1234");
  assert.equal(info.collectedAt, "2026-08-25T12:00:00.000Z");
  assert.deepEqual(info.diskFree, {
    path: home,
    totalKb: 1_943_276_448,
    usedKb: 512_000_000,
    availableKb: 1_200_000_000,
    capacityPct: 30,
  });
  assert.deepEqual(info.redisPingMs, { ok: true, ms: 41 });
  assert.equal(info.logs["codex-watch"].out.present, true);
  assert.equal(info.logs["codex-watch"].err.present, false);
  assert.equal(typeof info.logs["codex-watch"].out.ageSeconds, "number");

  // The doctrine line for this server: facts carry ages and timestamps, and the
  // calling agent does the interpreting. No grade may leak back into the tool.
  assert.doesNotMatch(JSON.stringify(info), /health|verdict|grade|stuck|summary/iu);
});

test("every collector degrades to a per-field error instead of throwing", async () => {
  const home = mkTempHome();
  const info = await collectMachineInfo(fakeDeps(home, {
    runCommandImpl: fakeRunCommand({
      tailscale: { ok: false, error: "tailscale not running" },
      git: { ok: false, error: "not a git repository" },
      df: { ok: false, error: "df: No such file" },
    }),
    networkInterfacesImpl: () => ({
      lo0: [{ family: "IPv4", address: "127.0.0.1" }],
      utun4: [{ family: "IPv4", address: "100.71.12.9" }],
    }),
    runAimCommandImpl: async () => ({ ok: false, exitCode: 1, durationMs: 77, stdout: "", stderr: "redis unreachable", truncated: false }),
  }));

  assert.equal(info.tailscaleIp, "100.71.12.9");
  assert.equal(info.aimgrRev, null);
  assert.equal(info.aimgrRevError, "not a git repository");
  assert.deepEqual(info.diskFree, { path: home, error: "df: No such file" });
  assert.deepEqual(info.redisPingMs, { ok: false, ms: 77, error: "redis unreachable" });

  const thrown = await collectMachineInfo(fakeDeps(home, {
    runAimCommandImpl: async () => {
      throw new Error("spawn blew up");
    },
  }));
  assert.deepEqual(thrown.redisPingMs, { ok: false, error: "spawn blew up" });
});

test("tailscale lookup prefers the CLI and falls back to a CGNAT interface", () => {
  assert.equal(
    resolveTailscaleIpv4({
      runCommandImpl: () => ({ ok: true, stdout: "100.96.80.106\nfd7a::1\n" }),
      networkInterfacesImpl: () => ({}),
    }),
    "100.96.80.106",
  );
  assert.equal(
    resolveTailscaleIpv4({
      runCommandImpl: () => ({ ok: false, error: "missing" }),
      networkInterfacesImpl: () => ({ en0: [{ family: "IPv4", address: "192.168.1.20" }] }),
    }),
    null,
  );
  assert.equal(parseDfKilobytes("").error, "df returned no rows");
});

test("routine receipts report only the newest run per routine id", () => {
  const home = mkTempHome();
  const runsDir = path.join(home, ".aimgr", "routine-runs");
  const nowMs = Date.now();
  const receipts = [
    { file: "morning-old.json", routineId: "morning", outcome: "completed", mtimeMs: nowMs - 7_200_000 },
    { file: "morning-new.json", routineId: "morning", outcome: "needs_attention", mtimeMs: nowMs - 600_000 },
    { file: "nightly.json", routineId: "nightly", outcome: "missed_window", mtimeMs: nowMs - 60_000 },
  ];
  for (const receipt of receipts) {
    const filePath = path.join(runsDir, receipt.file);
    writeJson(filePath, {
      routineId: receipt.routineId,
      fireKey: receipt.file.replace(".json", ""),
      outcome: receipt.outcome,
    });
    fs.utimesSync(filePath, receipt.mtimeMs / 1000, receipt.mtimeMs / 1000);
  }
  fs.writeFileSync(path.join(runsDir, "corrupt.json"), "{not json", "utf8");

  const newest = readNewestRoutineReceipts({ homeDir: home, nowMs });

  assert.deepEqual(newest, [
    { routineId: "nightly", fireKey: "nightly", outcome: "missed_window", ageSeconds: 60 },
    { routineId: "morning", fireKey: "morning-new", outcome: "needs_attention", ageSeconds: 600 },
  ]);
  assert.deepEqual(readNewestRoutineReceipts({ homeDir: mkTempHome() }), []);
});
