import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AIM_FLEET, CLAUDE_STATUS_SEPARATOR, parseRemoteStatus } from "../../src/cli/commands/cluster.js";
import { renderStatusText } from "../../src/status/render.js";
import { renderClusterStatusText } from "../../src/status/cluster-view.js";
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

// The per-machine grid above the account tables: "signed in" header, then claude and codex rows.
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

test("the fleet includes Minis 3 to 5", () => {
  for (const n of [3, 4, 5]) {
    assert.deepEqual(AIM_FLEET.find((machine) => machine.name === `mini-${n}`),
      { name: `mini-${n}`, target: `aelaguiz@amir-mini-${n}.fairy-salmon.ts.net` });
  }
});

test("cluster Codex averages displayed ready accounts once and hides accounts blocked everywhere", () => {
  const ready = (label, used, days, observedAt) => ({
    ...codex(label, "ready"), usageObservedAtMs: observedAt,
    usage: { ok: true, windows: [{ usedPercent: used, resetAt: NOW + days * DAY }] },
  });
  const machines = [
    { name: "m5", view: { accounts: [
      ready("first", 90, 1, NOW - DAY), ready("second", 70, 3, NOW),
      codex("blocked", "blocked"), codex("reauth", "reauth"), codex("unknown", "blocked"),
      { ...codex("unmeasured", "ready"), usage: { ok: false } },
    ] }, claude: { accounts: [] } },
    { name: "home", view: { accounts: [
      ready("first", 10, 1, NOW), codex("second", "blocked"), codex("blocked", "blocked"),
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
  assert.equal(row(codexText, "average").wk_used, "40%");
  assert.equal(row(codexText, "average").wk_in, "2.0d");
  assert.match(codexText, /Next 24h: 5% of pool weekly capacity frees up \(1 of 2 accounts reset, 3 without a reading not counted\)/);
});

test("cluster Codex shows no average when every account is blocked", () => {
  const text = renderClusterStatusText([
    { name: "m5", view: { accounts: [codex("blocked", "blocked")] }, claude: { accounts: [] } },
  ], { nowMs: NOW });
  const codexText = text.slice(text.indexOf("CODEX:"));
  assert.match(codexText, /CODEX: 0 accounts/);
  assert.doesNotMatch(codexText, /^blocked\s|^average\s/m);
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
  assert.doesNotMatch(result.stdout, /secret stderr/);
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

test("remote status parsing needs both reports", () => {
  const status = machineStatus();
  assert.deepEqual(parseRemoteStatus(remoteText(status)), status);
  assert.throws(() => parseRemoteStatus(JSON.stringify(status.view)));
});

test("cluster status rejects missing machine identity and unsupported arguments", async () => {
  const home = mkTempHome();
  await assert.rejects(runCli(["cluster", "status", "--home", home]), /Cannot identify this machine/);
  await assert.rejects(runCli(["cluster", "status", "--json", "--home", home]), /Usage: aim cluster status/);
});
