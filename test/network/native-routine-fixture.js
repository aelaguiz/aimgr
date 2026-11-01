import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot, publishCredential } from "../../src/coordination/redis-store.js";
import { executeRoutineWorker } from "../../src/routines/run.js";
import { runClaudeCli, runClaudeCliNoninteractive } from "../../src/targets/claude-runner.js";
import { runCli } from "../helpers/cli-runner.js";
import { runCliWithExitCode } from "../helpers/cli-runner.js";
import { formatCliError } from "../../src/cli/error.js";
import { prepareClaudeNativeRoute } from "../../src/network/claude-native-route.js";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";

export function installFixtureSecurityAdapter(homeDir) {
  if (process.platform !== "darwin") return;
  const installed = path.join(homeDir, ".aimgr/runtime/claude-file-store/security");
  if (fs.existsSync(installed)) return;
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  execFileSync("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    fileURLToPath(new URL("../../native/claude/security_shim.c", import.meta.url)), "-o", installed]);
  fs.chmodSync(installed, 0o500);
}

export async function verifyStartupDenied({ root, profile, destination, phase, received }) {
  const homeDir = path.join(root, `startup-${phase}`);
  fs.mkdirSync(homeDir);
  installFixtureSecurityAdapter(homeDir);
  const proof = path.join(homeDir, "started.json");
  const command = path.join(homeDir, "synthetic-claude.mjs");
  fs.writeFileSync(command, `#!${process.execPath}\nimport fs from 'node:fs'; const label=process.argv.at(-1); fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({label})); await fetch(${JSON.stringify(destination)}+'/startup-'+label);`, { mode: 0o700 });
  const keyPrefix = `startup-${phase}:`;
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://fake:6379", keyPrefix },
    claudeProxyProfiles: { [profile.profileRef]: { socksPort: profile.socksPort, expectedExits: profile.expectedExits } } } });
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(store, { credentials: ["protected", "ordinary"].map(label => ({
    provider: "anthropic", label, credential: buildAnthropicClaudeCredential(),
    policy: { expect: { email: "boss@example.com" }, ...(label === "protected" ? { egress: { profileRef: profile.profileRef } } : {}) },
    health: { status: "ready" },
  })) }, { updatedBy: "startup-test" });
  let stderr = "";
  const deps = { env: { HOME: homeDir, PATH: process.env.PATH },
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }),
    resolveExecutableOnPathImpl: () => command,
    runClaudeCliImpl: options => runClaudeCli({ ...options,
      prepareClaudeNativeRouteImpl: options => prepareClaudeNativeRoute({ ...options, profile: { ...options.profile, exitCheckUrl: `${destination}/exit` } }),
      spawnImpl: (command, args, options) => {
        const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe", "ipc"] });
        child.stdout.resume(); child.stderr.on("data", chunk => { stderr += chunk; });
        return child;
      },
    }),
  };
  let code;
  try { code = (await runCliWithExitCode(["claude", "run", "protected", "--", "protected"], deps)).exitCode; }
  catch (error) { code = 1; stderr += formatCliError(error); }
  assert.ok(code > 0, stderr);
  assert.match(stderr, /protected/);
  assert.ok(stderr.includes(profile.profileRef), stderr);
  assert.match(stderr, /unavailable/i);
  assert.match(stderr, /[Rr]epair.*(?:retry|resume)/);
  assert.equal(fs.existsSync(proof), false, "Claude child must not start");
  assert.equal(received.some(row => row.path === "/startup-protected"), false, "no protected direct or proxied model request");
  const ordinary = await runCliWithExitCode(["claude", "run", "ordinary", "--", "ordinary"], deps);
  assert.equal(ordinary.exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(proof)).label, "ordinary");
  assert.ok(received.some(row => row.path === "/startup-ordinary" && row.route !== "127.0.0.2"));
  console.log(JSON.stringify({ startupFailure: { phase, code, message: stderr.trim(), protectedChildStarted: false, protectedRequests: 0, ordinaryAccountLaunched: true } }));
}

// Only the Mac Herdr UI and Redis wire are fixtures. AIM's scheduler, account
// selection/lease, worker, native launcher, real CLI, hooks and route all run.
// Print mode makes this check unattended. It does not establish actual OS
// timer firing or interactive follow-up; the plan requires separate evidence.
export async function createNativeRoutineFixture({ root, profile, destination, claudeBin, routineId = "native", label = "a", scheduledDate = null, printMode = true }) {
  const homeDir = path.join(root, "routine-home");
  const cwd = path.join(homeDir, "work");
  fs.mkdirSync(cwd, { recursive: true });
  installFixtureSecurityAdapter(homeDir);
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    env: { ANTHROPIC_BASE_URL: destination, ANTHROPIC_API_KEY: "synthetic-routine-key" },
  }));
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  const promptFile = path.join(homeDir, "prompt.md");
  const keyPrefix = "native-routine-test:";
  writeAimgrConfig({ homeDir, config: {
    redis: { url: "redis://fake:6379", keyPrefix },
    ...(profile ? { claudeProxyProfiles: { [profile.profileRef]: { socksPort: profile.socksPort, expectedExits: profile.expectedExits } } } : {}),
    routines: { [routineId]: { agent: "claude", provider: "anthropic", model: "claude-sonnet-4-6", thinking: "high",
      calendar: scheduledDate ? [{ hour: scheduledDate.getHours(), minute: scheduledDate.getMinutes() }] : [{ hour: 7, minute: 0 }, { hour: 7, minute: 1 }, { hour: 7, minute: 2 }],
      cwd, promptFile, herdrSession: "fixture", spaceTitleFormat: "native · {scheduled_local}" } },
  } });
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix });
  const credential = buildAnthropicClaudeCredential();
  await importCredentialsSnapshot(store, { credentials: [{ provider: "anthropic", label, credential,
    identity: { accountUuid: "acct_boss", emailAddress: "boss@example.com", organizationUuid: "org_boss" },
    policy: { expect: { email: "boss@example.com" }, ...(profile ? { egress: { profileRef: profile.profileRef } } : {}), pool: { enabled: true } },
    health: { status: "ready", reason: null },
  }] }, { updatedBy: "synthetic-native-routine" });
  const receipts = [];
  const env = { ...process.env, HOME: homeDir, HERDR_SESSION: "fixture", HERDR_WORKSPACE_ID: "w", HERDR_PANE_ID: "p" };
  const spawnSyncImpl = (_command, args) => {
    let result = {};
    if (args.includes("list")) result = { type: "workspace_list", workspaces: [{ workspace_id: "existing", focused: true }] };
    if (args.includes("create")) result = { type: "workspace_created",
      workspace: { workspace_id: "w", label: args[args.indexOf("--label") + 1], focused: false },
      tab: { tab_id: "t", workspace_id: "w" },
      root_pane: { pane_id: "p", tab_id: "t", workspace_id: "w", cwd, focused: false } };
    return { status: 0, stdout: JSON.stringify({ result }), stderr: "" };
  };
  const start = async (minute, prompt) => {
    fs.writeFileSync(promptFile, prompt + "\n");
    const deps = { env, ...(scheduledDate ? {} : { routineNow: new Date(2026, 9, 31, 7, minute, 0) }), spawnSyncImpl,
      routineWorkspaceMoveImpl: async () => ({ verified: true, position: 1 }) };
    const args = ["routine", "run", routineId, "--json", "--home", homeDir];
    const queued = JSON.parse(await runCli(args, deps));
    assert.equal(queued.outcome, "queued");
    const owner = JSON.parse(fs.readFileSync(path.join(homeDir, ".aimgr", "routine-locks", routineId, "owner.json")));
    let exitCode = 0;
    const finished = executeRoutineWorker({ homeDir, cwd, env, opts: {}, nowMs: Date.now(),
      positional: ["routine", "__execute", routineId, queued.fireKey, owner.token],
      stdout: { write() {} }, stderr: { write() {} }, setExitCode: code => { exitCode = code; },
      resolveExecutableOnPathImpl: () => claudeBin,
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }),
      fetchJsonWithTimeoutImpl: async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 1, resets_at: new Date(Date.now() + 3600000).toISOString() } }) }),
      routineTimeouts: { pollMs: 25, initialTurnMs: 30000 },
      runClaudeCliImpl: launch => {
        // Inject the synthetic origin into the actual generated hook overlay.
        // AIM deliberately strips competing backend env variables on launch.
        const overlayPath = launch.preparedLaunch.userHooksPath;
        const overlay = JSON.parse(fs.readFileSync(overlayPath));
        overlay.env = { ANTHROPIC_BASE_URL: destination, ANTHROPIC_API_KEY: "synthetic-routine-key" };
        fs.writeFileSync(overlayPath, JSON.stringify(overlay), { mode: 0o600 });
        if (!printMode) {
          const appState = path.join(launch.configDir, ".claude.json");
          const current = JSON.parse(fs.readFileSync(appState, "utf8"));
          fs.writeFileSync(appState, JSON.stringify({ ...current, hasCompletedOnboarding: true, primaryApiKey: "synthetic-routine-key",
            customApiKeyResponses: { approved: ["synthetic-routine-key"], rejected: [] } }));
        }
        return runClaudeCli({ ...launch, egressProfile: profile ? { ...launch.egressProfile, exitCheckUrl: profile.exitCheckUrl } : null,
          args: printMode ? ["-p", "--output-format", "json", ...launch.args] : launch.args });
      },
    }).then(() => {
      const receipt = JSON.parse(fs.readFileSync(queued.receiptPath));
      receipts.push({ fireKey: receipt.fireKey, outcome: receipt.outcome, selectedAccount: receipt.selectedAccount?.binding,
        promptAdmitted: Boolean(receipt.prompt.admittedAt), initialTurn: receipt.initialTurn?.status,
        exitCode, nativeExit: receipt.interactiveTui?.exitCode, needsAttention: receipt.needsAttention });
      return receipt;
    });
    // Attach immediately while the caller waits for an origin/failure event.
    finished.catch(() => {});
    return { finished, duplicate: async () => JSON.parse(await runCli(args, deps)),
      attemptOverlap: async () => JSON.parse(await runCli([...args, "--manual"], deps)), queued };
  };
  const maintain = async (unavailable = false, activeLease = false) => {
    const before = (await readSnapshot(store)).credentials[0];
    const due = structuredClone(before);
    due.credential.nativeClaudeBundle.claudeAiOauth.expiresAt = Date.now() - 60000;
    assert.equal((await publishCredential(store, { expectedVersion: before.version, credentialRecord: due, updatedBy: "synthetic-scheduled-maintenance" })).ok, true);
    const projected = path.join(homeDir, `.aimgr/claude-homes/${label}/.claude/.credentials.json`);
    if (fs.existsSync(projected)) {
      const content = JSON.parse(fs.readFileSync(projected));
      content.claudeAiOauth.expiresAt = due.credential.nativeClaudeBundle.claudeAiOauth.expiresAt;
      fs.writeFileSync(projected, JSON.stringify(content), { mode: 0o600 });
    }
    const proof = path.join(homeDir, "maintenance-child.json");
    const command = path.join(homeDir, "synthetic-native-maintenance.mjs");
    fs.writeFileSync(command, `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
const route=await (await fetch(${JSON.stringify(destination + "/maintenance-" + label)})).text();
fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({route,uid:process.getuid()}));
const file=path.join(process.env.CLAUDE_CONFIG_DIR,'.credentials.json');const content=JSON.parse(fs.readFileSync(file));
content.claudeAiOauth.accessToken+='-synthetic-refreshed';content.claudeAiOauth.expiresAt=Date.now()+7200000;
fs.writeFileSync(file,JSON.stringify(content),{mode:0o600});\n`, { mode: 0o700 });
    const output = await runCli(["auth", "maintain", "--home", homeDir], { env,
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }), resolveExecutableOnPathImpl: () => command,
      runClaudeCliNoninteractiveImpl: launch => runClaudeCliNoninteractive({ ...launch,
        egressProfile: profile ? { ...launch.egressProfile, exitCheckUrl: profile.exitCheckUrl } : null }),
    });
    const after = (await readSnapshot(store)).credentials[0];
    assert.deepEqual(after.policy.egress, before.policy.egress);
    assert.deepEqual(after.identity, before.identity);
    assert.notEqual(after.policy.reauth?.blockedReason, "oauth_reauth_required");
    if (unavailable || activeLease) {
      assert.match(output, activeLease ? /outcome=skipped reason=lease_busy/ : /outcome=retryable reason=(?:proxy_unavailable|native_proxy_unavailable)/);
      assert.equal(fs.existsSync(proof), false);
      assert.equal(after.credential.nativeClaudeBundle.claudeAiOauth.accessToken, before.credential.nativeClaudeBundle.claudeAiOauth.accessToken);
    } else {
      assert.match(output, /outcome=refreshed/);
      assert.ok(JSON.parse(fs.readFileSync(proof)).route.includes(profile.expectedExits[0]));
      assert.notEqual(after.credential.nativeClaudeBundle.claudeAiOauth.accessToken, before.credential.nativeClaudeBundle.claudeAiOauth.accessToken);
    }
    console.log(JSON.stringify({ unattendedMaintenance: { unavailable, activeLease, output: output.trim(), assignmentAndIdentityPreserved: true,
      nativeCommand: "synthetic refresh exchange; actual AIM maintenance and native enforcement" } }));
  };
  return { start, receipts, cwd, homeDir, routineId, maintain };
}
