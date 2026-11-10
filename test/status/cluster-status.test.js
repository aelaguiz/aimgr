import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AIM_FLEET } from "../../src/cli/commands/cluster.js";
import { renderStatusText } from "../../src/status/render.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

function homeFor(machine) {
  const home = mkTempHome();
  fs.mkdirSync(path.join(home, ".devcluster"));
  fs.writeFileSync(path.join(home, ".devcluster", "machine"), `${machine}\n`);
  return home;
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

test("cluster status renders every machine and uses local status for the current machine", async () => {
  const home = homeFor("mini-2");
  const targets = [];
  let localCalls = 0;
  const result = await runCliWithExitCode(["cluster", "status", "--home", home], {
    clusterLocalStatusImpl: async () => { localCalls++; return "COORDINATION redis=live\nlocal account\n"; },
    clusterRemoteStatusImpl: async (target) => { targets.push(target); return `COORDINATION redis=live\n${target}\n`; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(localCalls, 1);
  assert.equal(targets.length, AIM_FLEET.length - 1);
  assert.ok(!targets.includes(AIM_FLEET.find((m) => m.name === "mini-2").target));
  for (const machine of AIM_FLEET) assert.match(result.stdout, new RegExp(`=== ${machine.name} ===`));
  assert.match(result.stdout, /=== mini-2 ===\nCOORDINATION redis=live\nlocal account/);
});

test("cluster status reports failures while keeping other machines and returns failure", async () => {
  const home = homeFor("m5");
  const result = await runCliWithExitCode(["cluster", "status", "--home", home], {
    clusterLocalStatusImpl: async () => "local works\n",
    clusterRemoteStatusImpl: async (target) => {
      if (target.includes("mini-1")) throw Object.assign(new Error("secret stderr"), { killed: true });
      if (target.includes("mini-2")) throw new Error("secret stderr");
      return "remote works\n";
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /=== mini-1 ===\nERROR: timed out/);
  assert.match(result.stdout, /=== mini-2 ===\nERROR: status unavailable/);
  assert.match(result.stdout, /=== studio ===\nremote works/);
  assert.doesNotMatch(result.stdout, /secret stderr/);
});

test("cluster status rejects missing machine identity and unsupported arguments", async () => {
  const home = mkTempHome();
  await assert.rejects(runCli(["cluster", "status", "--home", home]), /Cannot identify this machine/);
  await assert.rejects(runCli(["cluster", "status", "--json", "--home", home]), /Usage: aim cluster status/);
});
