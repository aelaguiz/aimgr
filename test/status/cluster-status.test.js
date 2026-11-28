import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AIM_FLEET, CLAUDE_STATUS_SEPARATOR, parseRemoteStatus } from "../../src/cli/commands/cluster.js";
import { renderStatusText } from "../../src/status/render.js";
import { renderClusterStatusText } from "../../src/status/cluster-view.js";
import { withAgyConnection } from "../../src/credentials/agy-local.js";
import { AGY_STATUS_STALE_MS, readLocalAgyStatus } from "../../src/status/agy-view.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

const NOW = Date.parse("2026-11-10T18:00:00Z");
const DAY = 86_400_000;

function homeFor(machine) {
  const home = mkTempHome();
  fs.mkdirSync(path.join(home, ".devcluster"));
  fs.writeFileSync(path.join(home, ".devcluster", "machine"), `${machine}\n`);
  return home;
}

function signedIn(label, weekUsed, observedAtMs) {
  return {
    label, subscriptionType: "max", rateLimitTier: "max_20x", authState: "usage_readable", credentialState: "credential_ready",
    credentialReady: true, locked: false, egress: { mode: "direct" }, usageObservedAtMs: observedAtMs,
    usage: { ok: true, windows: [{ label: "Week", kind: "weekly_all", usedPercent: weekUsed, resetAt: NOW + 2 * DAY, active: true }] },
  };
}

function notSignedIn(label) {
  return {
    label, authState: "credential_missing", credentialState: "credential_missing", credentialReady: false, locked: false,
    egress: { mode: "direct" }, usage: { ok: false, windows: [] },
  };
}

function codex(label, status) {
  return {
    label, provider: "openai-codex", operator: { status }, plan: status === "ready" ? "pro" : null,
    usage: status === "ready" ? { ok: true, windows: [{ usedPercent: 30, resetAt: NOW + DAY }] } : { ok: false },
  };
}

function machineStatus({ alpha = null, codexReady = false } = {}) {
  return {
    view: { accounts: [codex("cx", codexReady ? "ready" : "blocked")] },
    claude: { ok: false, accounts: [alpha ?? notSignedIn("alpha"), notSignedIn("beta")] },
  };
}

function remoteText(status) {
  return `${JSON.stringify(status.view)}\n${CLAUDE_STATUS_SEPARATOR}\n${JSON.stringify(status.claude)}\n`;
}

function row(output, label) {
  const lines = output.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${label} `));
  const header = lines.slice(0, index).findLast((line) => line.startsWith("account ")).split(/\s{2,}/);
  const cells = lines[index].split(/\s{2,}/);
  return Object.fromEntries(header.map((name, index) => [name, cells[index]]));
}

// The per-machine grid above the account tables.
function gridRow(output, provider) {
  const lines = output.split("\n");
  const header = lines.find((line) => line.startsWith("signed in ")).split(/\s{2,}/);
  const cells = lines.find((line) => line.startsWith(`${provider} `)).split(/\s{2,}/);
  return Object.fromEntries(header.map((name, index) => [name, cells[index]]));
}

test("all-accounts keeps blocked Codex and Claude accounts visible in their usual tables", () => {
  const view = { redis: { status: "live" }, accounts: [
    { label: "codex-no-login", provider: "openai-codex", operator: { status: "blocked" }, credentials: { status: "login_required" } },
    { label: "claude-no-login", provider: "anthropic", operator: { status: "blocked" } },
  ] };
  const claudeUsageStatus = { accounts: [{ label: "claude-no-login", credentialState: "login_required", usage: { windows: [] } }] };
  const normal = renderStatusText(view, { claudeUsageStatus });
  const all = renderStatusText(view, { claudeUsageStatus, includeBlocked: true });
  assert.doesNotMatch(normal, /codex-no-login|claude-no-login/);
  assert.match(all, /codex-no-login\s+blocked.*auth=login_required/);
  assert.match(all, /claude-no-login/);
});

test("the fleet includes the old M1", () => {
  assert.deepEqual(AIM_FLEET.find((machine) => machine.name === "old-m1"),
    { name: "old-m1", target: "aelaguiz@amir-old-m1.fairy-salmon.ts.net" });
});

test("status --cluster is the same cluster status command", async () => {
  const home = homeFor("mini-3");
  const deps = {
    nowImpl: () => NOW,
    clusterLocalStatusImpl: async () => machineStatus(),
    clusterRemoteStatusImpl: async () => remoteText(machineStatus()),
  };
  for (const format of [[], ["--json"]]) {
    const normal = await runCliWithExitCode(["cluster", "status", "--home", home, ...format], deps);
    const alias = await runCliWithExitCode(["status", "--cluster", "--home", home, ...format], deps);
    assert.deepEqual(alias, normal);
  }
});

test("the fleet includes Minis 3 to 5", () => {
  for (const n of [3, 4, 5]) {
    assert.deepEqual(AIM_FLEET.find((machine) => machine.name === `mini-${n}`),
      { name: `mini-${n}`, target: `aelaguiz@amir-mini-${n}.fairy-salmon.ts.net` });
  }
});

test("cluster Codex weighs each displayed ready account once and hides accounts blocked everywhere", () => {
  const ready = (label, used, days, observedAt, resetCreditsAvailable) => ({
    ...codex(label, "ready"),
    plan: label === "first" ? "pro ($2.00)" : "promax",
    usageObservedAtMs: observedAt,
    usage: { ok: true, windows: [{ usedPercent: used, resetAt: NOW + days * DAY }], resetCreditsAvailable },
  });
  const machines = [
    { name: "m5", view: { accounts: [
      ready("first", 90, 1, NOW - DAY, 9), ready("second", 70, 3, NOW, 3),
      codex("blocked", "blocked"),
      { ...codex("reauth", "reauth"), usage: { ok: false, resetCreditsAvailable: 10 } },
      codex("unknown", "blocked"),
      { ...codex("unmeasured", "ready"), usage: { ok: false } },
    ] }, claude: { accounts: [] } },
    { name: "home", view: { accounts: [
      ready("first", 10, 1, NOW, 0), codex("second", "blocked"), codex("blocked", "blocked"),
      codex("unknown", "unknown"),
    ] }, claude: { accounts: [] } },
  ];
  const text = renderClusterStatusText(machines, { nowMs: NOW });
  assert.doesNotMatch(text, /^blocked\s/m);
  assert.match(text, /CODEX: 5 accounts · 3 ready · 2 not signed in anywhere/);
  assert.equal(row(text, "first").wk_used, "10%");
  assert.equal(row(text, "second").wk_used, "70%");
  assert.equal(row(text, "unknown").st, "unknown");
  const codexText = text.slice(text.indexOf("CODEX:"));
  assert.equal(row(codexText, "pool").wk_used, "51%");
  assert.equal(row(codexText, "pool").wk_in, "3.0d");
  assert.match(codexText, /Pool: 1\.5 Pro Max weeks \(a pro account counts 0\.46\) · 0\.7 used \(51%\) · 0\.7 left \(49%\)/);
  assert.match(codexText, /Not counted: 3 accounts without a reading\nReset credits unused: 3 on 1 account\n$/);
  assert.equal(gridRow(text, "codex left").m5, "0.7");
  assert.equal(gridRow(text, "codex left").home, "0.4");
});

test("cluster Codex uses the freshest usage timestamp in the reading", () => {
  const hour = 3_600_000;
  const machine = (name, usedPercent, observedAtMs) => ({
    name,
    view: { accounts: [{
      ...codex("shared", "ready"),
      usage: { ok: true, observedAtMs, windows: [{ usedPercent, resetAt: NOW + DAY }] },
    }] },
  });
  const text = renderClusterStatusText([
    machine("m5", 20, NOW - DAY),
    machine("home", 80, NOW - 2 * hour),
  ], { nowMs: NOW });
  assert.equal(row(text, "shared").wk_used, "80%");
  assert.match(text, /Readings: 1 of 1 are over an hour old \(oldest 2\.0h\)/);
});

test("cluster Codex shows no pool row when every account is blocked", () => {
  const text = renderClusterStatusText([
    { name: "m5", view: { accounts: [codex("blocked", "blocked")] }, claude: { accounts: [] } },
  ], { nowMs: NOW });
  const codexText = text.slice(text.indexOf("CODEX:"));
  assert.match(codexText, /CODEX: 0 accounts/);
  assert.doesNotMatch(codexText, /^blocked\s|^pool\s/m);
  assert.match(codexText, /Pool: no weekly usage readings\n$/);
});

test("cluster status combines every machine into one row per account with one machines cell", async () => {
  const home = homeFor("mini-2");
  const targets = [];
  let localCalls = 0;
  const result = await runCliWithExitCode(["cluster", "status", "--home", home], {
    nowImpl: () => NOW,
    clusterLocalStatusImpl: async () => { localCalls++; return machineStatus({ alpha: signedIn("alpha", 40, NOW - 60_000) }); },
    clusterRemoteStatusImpl: async (target) => {
      targets.push(target);
      if (target.includes("amir-m5")) return remoteText(machineStatus({ alpha: signedIn("alpha", 55, NOW), codexReady: true }));
      return remoteText(machineStatus());
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(localCalls, 1);
  assert.equal(targets.length, AIM_FLEET.length - 1);
  assert.ok(!targets.includes(AIM_FLEET.find((m) => m.name === "mini-2").target));
  assert.match(result.stdout, new RegExp(`AIM CLUSTER: ${AIM_FLEET.length} of ${AIM_FLEET.length} machines answered`));
  assert.doesNotMatch(result.stdout, /===/);
  assert.equal(result.stdout.match(/^CLAUDE: /gm).length, 1);
  assert.equal(result.stdout.match(/^CODEX: /gm).length, 1);

  const alpha = row(result.stdout, "alpha");
  assert.equal(alpha.status, "READY");
  assert.equal(alpha.on, `2/${AIM_FLEET.length}`);
  assert.equal(alpha.week, "55%", "usage comes from the freshest machine with a login");
  assert.equal(alpha.machines, "m5, mini-2", "a minority login lists where it is signed in");
  for (const machine of AIM_FLEET) assert.equal(alpha[machine.name], undefined, "no column per machine");
  const beta = row(result.stdout, "beta");
  assert.equal(beta.status, "NOT SIGNED IN");
  assert.equal(beta.on, `0/${AIM_FLEET.length}`);
  assert.equal(beta.machines, "none");
  assert.match(result.stdout, /CLAUDE: 2 accounts · 1 ready · 0 limited · 0 in use · 1 not signed in anywhere/);
  assert.match(result.stdout, new RegExp(`Signed in on all ${AIM_FLEET.length} machines: 0 · on some: 1 · on none: 1`));

  const cx = row(result.stdout, "cx");
  assert.equal(cx.on, `1/${AIM_FLEET.length}`);
  assert.equal(cx.machines, "m5");

  const grid = gridRow(result.stdout, "claude");
  assert.equal(grid.m5, "1");
  assert.equal(grid["mini-2"], "1");
  assert.equal(grid.studio, "0");
  assert.equal(gridRow(result.stdout, "codex").m5, "1");
  assert.equal(gridRow(result.stdout, "claude left").m5, "0.4");
  assert.equal(gridRow(result.stdout, "claude left")["mini-2"], "0.4");
  assert.equal(gridRow(result.stdout, "claude left").studio, "0.0");
  assert.ok(result.stdout.split("\n").every((line) => line.length <= 140), "the report stays one screen wide");
});

test("cluster status names machines that did not answer, marks them in the machine grid and returns failure", async () => {
  const home = homeFor("m5");
  const result = await runCliWithExitCode(["cluster", "status", "--home", home], {
    nowImpl: () => NOW,
    clusterLocalStatusImpl: async () => machineStatus({ alpha: signedIn("alpha", 10, NOW) }),
    clusterRemoteStatusImpl: async (target) => {
      if (target.includes("mini-1")) throw Object.assign(new Error("secret stderr"), { killed: true });
      if (target.includes("mini-2")) throw new Error("secret stderr");
      if (target.includes("old-m1")) return "not json at all";
      return remoteText(machineStatus());
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, new RegExp(
    `AIM CLUSTER: ${AIM_FLEET.length - 3} of ${AIM_FLEET.length} machines answered · mini-1: timed out · mini-2: status unavailable · old-m1: status unavailable`,
  ));
  const alpha = row(result.stdout, "alpha");
  assert.equal(alpha.on, `1/${AIM_FLEET.length - 3}`);
  assert.equal(alpha.machines, "m5", "machines that did not answer are left out");
  const grid = gridRow(result.stdout, "claude");
  assert.equal(grid["mini-1"], "x");
  assert.equal(grid["old-m1"], "x");
  assert.equal(grid.studio, "0");
  assert.equal(gridRow(result.stdout, "claude left")["mini-1"], "x");
  assert.equal(gridRow(result.stdout, "codex left")["old-m1"], "x");
  assert.doesNotMatch(result.stdout, /secret stderr/);
});

test("cluster counts known Antigravity grant states from local and mixed-version remote status", async (t) => {
  const home = homeFor("mini-3");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const connection = path.join(home, ".aimgr", "agy", "workspace");
  const grantDir = path.join(connection, "home", ".gemini", "antigravity-cli");
  fs.mkdirSync(grantDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(connection, "connection.json"), '{"version":1,"label":"workspace"}', { mode: 0o600 });
  fs.writeFileSync(path.join(grantDir, "antigravity-oauth-token"), "synthetic-secret", { mode: 0o600 });
  const localDeps = {
    readLocalAgyStatusImpl: (homeDir, options) => readLocalAgyStatus(homeDir, {
      ...options, runtimeRoot: path.join(home, "missing-runtime"),
    }),
  };
  const local = JSON.parse(await runCli(["status", "--json", "--home", home], localDeps));
  assert.deepEqual(local.agy.connections.map(({ label, status }) => ({ label, status })), [{ label: "workspace", status: "ready" }]);

  const report = (connections, runtime = "supported", localState = "available") => ({ runtime, localState, connections });
  const result = await runCliWithExitCode(["cluster", "status", "--home", home], {
    ...localDeps,
    nowImpl: () => NOW,
    clusterRemoteStatusImpl: async (target) => {
      const { name } = AIM_FLEET.find((machine) => machine.target === target);
      const status = machineStatus({ codexReady: name === "m3-max" });
      if (name === "m3-36gb") throw Object.assign(new Error("synthetic-secret"), { code: 255 });
      if (name === "m5") status.view.agy = report([]);
      if (name === "home") status.view.agy = report([], "unsupported");
      if (name === "mini-2") status.view.agy = report([{ label: "workspace", status: "needs-sign-in" }]);
      if (name === "mini-4") status.view.agy = report([{ label: "workspace", status: "invalid-state" }]);
      if (name === "m3-max") status.view.agy = report([{ label: "synthetic-secret@example.test", status: "ready" }]);
      if (name === "studio") status.view.agy = report([{ label: "workspace", status: "unknown" }], "supported", "unavailable");
      if (name === "old-m1") {
        status.view.agy = report([{ label: "workspace", status: "not-enrolled", accountHome: "/synthetic-secret" }]);
        return `${JSON.stringify(status.view)}\n${CLAUDE_STATUS_SEPARATOR}\n`;
      }
      return remoteText(status);
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(row(result.stdout, "workspace")["local grants"], "1/5");
  assert.equal(row(result.stdout, "workspace")["grant on"], "mini-3");
  assert.match(row(result.stdout, "workspace")["availability by machine"], /unsupported platform home.*sign-in required mini-2.*invalid local state mini-4/);
  const agy = gridRow(result.stdout, "agy grants");
  assert.equal(agy["mini-3"], local.agy.runtime === "supported" ? "1" : "1*");
  assert.equal(agy["mini-5"], "old");
  assert.equal(agy["m3-max"], "?");
  assert.equal(agy["m3-36gb"], "x");
  assert.equal(agy.studio, "?");
  assert.equal(agy.home, "0*");
  assert.equal(agy["mini-4"], "0+?");
  assert.equal(gridRow(result.stdout, "codex")["m3-max"], "1");
  assert.equal(gridRow(result.stdout, "claude left")["old-m1"], "x");
  assert.match(result.stdout, /Claude status unavailable: mini-3, old-m1/);
  assert.match(result.stdout, /m3-36gb: SSH connection failed/);
  assert.doesNotMatch(result.stdout, /synthetic-secret/);
});

test("ordinary and cluster status refresh Antigravity quota on demand with a shared cache", async (t) => {
  const home = homeFor("mini-3");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runtimeRoot = path.join(home, "runtime");
  const artifactSet = "a".repeat(64);
  const bundle = path.join(runtimeRoot, "artifacts", artifactSet);
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "active.json"), JSON.stringify({ schema: 1, artifactSet }));
  fs.writeFileSync(path.join(bundle, "approval.json"), JSON.stringify({ privacyAbi: "agy-privacy-v2" }));
  for (const name of ["agy", "launcher", "policy.json"]) fs.writeFileSync(path.join(bundle, name), "");

  const connection = path.join(home, ".aimgr", "agy", "workspace");
  const accountHome = path.join(connection, "home");
  const grantDir = path.join(accountHome, ".gemini", "antigravity-cli");
  fs.mkdirSync(grantDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(connection, "connection.json"), '{"version":1,"label":"workspace"}', { mode: 0o600 });
  fs.writeFileSync(path.join(grantDir, "antigravity-oauth-token"), "synthetic-secret", { mode: 0o600 });
  let now = NOW;
  let remaining = 0.82;
  let reset = NOW + 60_000;
  let failed = false;
  const calls = [];
  const deps = {
    nowImpl: () => now,
    readLocalAgyStatusImpl: (homeDir, options) => readLocalAgyStatus(homeDir, { ...options, platform: "darwin", arch: "arm64", runtimeRoot }),
    clusterRemoteStatusImpl: async () => remoteText(machineStatus()),
    runAgyNativeImpl(invocation) {
      calls.push({ operation: invocation.operation, label: invocation.label, home: invocation.accountHome });
      const { operation } = invocation;
      if (failed) return { exitCode: 1 };
      const data = operation === "usage" ? { groups: [{ name: "Gemini Models", buckets: [
        { window: "weekly", remaining_fraction: remaining, reset_time: new Date(reset).toISOString() },
      ] }] } : { plan_name: "Google AI Pro" };
      return { exitCode: 0, statusReport: JSON.stringify({ status: "SUCCESS", num_turns: 0, conversation_id: "", command: { name: operation, data } }) };
    },
  };
  const status = (...args) => runCliWithExitCode(["status", "--home", home, ...args], deps);
  const operations = () => calls.map(({ operation }) => operation);
  const initial = await status();
  assert.match(initial.stdout, /workspace.*82% left/);
  assert.deepEqual(calls, ["usage", "credits"].map((operation) => ({ operation, label: "workspace", home: fs.realpathSync(accountHome) })));
  const localJson = JSON.parse((await status("--json")).stdout);
  assert.deepEqual(localJson.pools.agy.accountRows[0].observation, localJson.agy.connections[0].observation);
  assert.equal(localJson.pools.agy.accountRows[0].observation.buckets[0].remainingFraction, 0.82);
  assert.match((await status("--cluster")).stdout, /workspace.*82% left/);
  assert.equal(calls.length, 2);

  now = reset;
  reset = now + DAY;
  remaining = 1;
  assert.match((await status("--cluster")).stdout, /workspace.*100% left/);
  assert.deepEqual(operations(), ["usage", "credits", "usage", "credits"]);

  now += AGY_STATUS_STALE_MS;
  await withAgyConnection(home, "workspace", async () => {
    assert.match((await status()).stdout, /workspace.*in use.*100% left/);
    assert.equal(calls.length, 4);
  });
  failed = true;
  const fallback = await status();
  assert.match(fallback.stdout, /workspace.*100% left.*stale/);
  assert.deepEqual(operations(), ["usage", "credits", "usage", "credits", "usage"]);
  await status("--cluster");
  assert.equal(calls.length, 5);
  now += AGY_STATUS_STALE_MS;
  remaining = 0.77;
  failed = false;
  assert.match((await status()).stdout, /workspace.*77% left/);
  assert.deepEqual(operations().slice(-2), ["usage", "credits"]);
});

test("the machines cell names the minority and keeps attention marks", () => {
  const names = ["a", "b", "c", "d", "e"];
  const statuses = {
    everywhere: ["ready", "ready", "ready", "ready", "ready"],
    wide: ["ready", "ready", "ready", "blocked", "reauth"],
    narrow: ["ready", "reauth", "unknown", "blocked", "blocked"],
  };
  const machines = names.map((name, index) => ({
    name, claude: { accounts: [] },
    view: { accounts: Object.entries(statuses).map(([label, list]) => codex(label, list[index])) },
  }));
  machines.push({ name: "f", error: "timed out" });
  const text = renderClusterStatusText(machines, { nowMs: NOW });
  assert.equal(row(text, "everywhere").machines, "all", "a machine that did not answer does not count against all");
  assert.equal(row(text, "wide").machines, "all but d, e!");
  assert.equal(row(text, "narrow").machines, "a, b!, c?");
  assert.equal(gridRow(text, "codex").f, "x");
});

test("cluster Claude drops usage columns no account has a reading for", () => {
  const opus = { ...signedIn("opus-user", 20, NOW), usage: { ok: true, windows: [
    { label: "Week", kind: "weekly_all", usedPercent: 20, resetAt: NOW + DAY, active: true },
    { label: "Opus", kind: "weekly_scoped", usedPercent: 5, resetAt: NOW + DAY, active: true },
  ] } };
  const render = (accounts) => renderClusterStatusText([{ name: "m5", view: { accounts: [] }, claude: { accounts } }], { nowMs: NOW });
  const header = (text) => text.split("\n").find((line) => line.startsWith("account ")).split(/\s{2,}/);
  assert.deepEqual(header(render([signedIn("alpha", 40, NOW)])), ["account", "status", "on", "plan", "week", "wk_in", "machines"]);
  assert.ok(header(render([signedIn("alpha", 40, NOW), opus])).includes("Opus"));
});

test("remote status parsing keeps general status if the Claude report is invalid", () => {
  const status = machineStatus();
  assert.deepEqual(parseRemoteStatus(remoteText(status)), status);
  assert.deepEqual(parseRemoteStatus(`${JSON.stringify(status.view)}\n${CLAUDE_STATUS_SEPARATOR}\n`), {
    ...status, claude: null,
  });
  assert.throws(() => parseRemoteStatus(JSON.stringify(status.view)));
});

test("cluster status rejects missing machine identity and unsupported arguments", async () => {
  const home = mkTempHome();
  await assert.rejects(runCli(["cluster", "status", "--home", home]), /Cannot identify this machine/);
  await assert.rejects(runCli(["cluster", "status", "--compact", "--home", home]), /Usage: aim cluster status/);
});

test("cluster status --json gives one pool from every machine's freshest reading", async () => {
  const home = homeFor("m5");
  const stale = signedIn("alpha", 0, NOW - 5 * DAY);
  const agy = (observedAtMs, remainingFraction, availability = "ready") => ({
    runtime: "supported", localState: "available", connections: [{
      label: "workspace", status: "ready", availability, accountHome: "route-secret-marker",
      observation: { observedAtMs, buckets: [{ id: "gemini-weekly", remainingFraction }] },
    }],
  });
  const result = await runCliWithExitCode(["cluster", "status", "--json", "--home", home], {
    nowImpl: () => NOW,
    // This machine's own reading is days old and says the account is unused.
    clusterLocalStatusImpl: async () => {
      const status = machineStatus({ alpha: stale });
      status.view.agy = agy(NOW - DAY, 0);
      return status;
    },
    clusterRemoteStatusImpl: async (target) => {
      if (target.includes("mini-1")) {
        const status = machineStatus({ alpha: signedIn("alpha", 100, NOW), codexReady: true });
        status.view.agy = agy(NOW, 0.8, "in-use");
        return remoteText(status);
      }
      if (target.includes("mini-2")) throw new Error("secret stderr");
      if (target.includes("old-m1")) {
        const status = machineStatus();
        status.view.agy = { runtime: "unsupported", localState: "available", connections: [] };
        return remoteText({ ...status, claude: null });
      }
      return remoteText(machineStatus());
    },
  });
  assert.equal(result.exitCode, 1, "a machine that did not answer still fails the command");
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.machines.find((machine) => machine.name === "mini-2"), { name: "mini-2", error: "status unavailable" });
  assert.deepEqual(report.machines.find((machine) => machine.name === "mini-1"), { name: "mini-1" });
  assert.deepEqual(report.machines.find((machine) => machine.name === "old-m1"), {
    name: "old-m1", claudeError: "status unavailable",
  });
  const { claude, codex } = report.pools;
  assert.equal(claude.unit, "Max 20x weeks");
  assert.equal(claude.readings, "every machine");
  assert.equal(codex.readings, "every machine");
  assert.equal(claude.capacity, 1);
  assert.equal(claude.left, 0, "the fresh reading from another machine wins over this machine's stale one");
  assert.deepEqual(claude.counts, { ready: 0, limited: 1, needsLogin: 0 });
  assert.equal(claude.accountRows.find((row) => row.label === "alpha").weekUsedPercent, 100);
  assert.equal(codex.unit, "Pro Max weeks");
  assert.equal(codex.counts.ready, 1);
  assert.deepEqual(report.pools.agy, {
    readings: "every machine",
    accountRows: [{
      label: "workspace",
      observation: { observedAtMs: NOW, buckets: [{ id: "gemini-weekly", remainingFraction: 0.8 }] },
      machines: {
        m5: { status: "ready", availability: "ready" },
        "mini-1": { status: "ready", availability: "in-use" },
        "old-m1": { status: "not-enrolled", availability: "unsupported" },
      },
    }],
  });
  assert.doesNotMatch(result.stdout, /secret stderr|route-secret-marker/);
});
