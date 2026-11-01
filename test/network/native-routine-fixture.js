import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { executeRoutineWorker } from "../../src/routines/run.js";
import { runClaudeCli } from "../../src/targets/claude-runner.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";

// Only the Mac Herdr UI and Redis wire are fixtures. AIM's scheduler, account
// selection/lease, worker, native launcher, real CLI, hooks and route all run.
// Print mode makes this Linux check unattended; interactive follow-up remains
// covered by lifecycle unit tests and the deferred joint Mac acceptance.
export async function createNativeRoutineFixture({ root, profile, destination, claudeBin }) {
  const homeDir = path.join(root, "routine-home");
  const cwd = path.join(homeDir, "work");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".claude"));
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    env: { ANTHROPIC_BASE_URL: destination, ANTHROPIC_API_KEY: "synthetic-routine-key" },
  }));
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  const promptFile = path.join(homeDir, "prompt.md");
  const keyPrefix = "native-routine-test:";
  writeAimgrConfig({ homeDir, config: {
    redis: { url: "redis://fake:6379", keyPrefix },
    claudeProxyProfiles: { test_a: { socksPort: profile.socksPort, expectedExits: profile.expectedExits } },
    routines: { native: { agent: "claude", provider: "anthropic", model: "claude-sonnet-4-6", thinking: "high",
      calendar: [{ hour: 7, minute: 0 }, { hour: 7, minute: 1 }, { hour: 7, minute: 2 }],
      cwd, promptFile, herdrSession: "fixture", spaceTitleFormat: "native · {scheduled_local}" } },
  } });
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix });
  const credential = buildAnthropicClaudeCredential();
  await importCredentialsSnapshot(store, { credentials: [{ provider: "anthropic", label: "a", credential,
    identity: { accountUuid: "acct_boss", emailAddress: "boss@example.com", organizationUuid: "org_boss" },
    policy: { expect: { email: "boss@example.com" }, egress: { profileRef: "test_a" }, pool: { enabled: true } },
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
    const deps = { env, routineNow: new Date(2026, 9, 31, 7, minute, 0), spawnSyncImpl,
      routineWorkspaceMoveImpl: async () => ({ verified: true, position: 1 }) };
    const args = ["routine", "run", "native", "--json", "--home", homeDir];
    const queued = JSON.parse(await runCli(args, deps));
    assert.equal(queued.outcome, "queued");
    const owner = JSON.parse(fs.readFileSync(path.join(homeDir, ".aimgr", "routine-locks", "native", "owner.json")));
    let exitCode = 0;
    const finished = executeRoutineWorker({ homeDir, cwd, env, opts: {}, nowMs: Date.now(),
      positional: ["routine", "__execute", "native", queued.fireKey, owner.token],
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
        return runClaudeCli({ ...launch, egressProfile: { ...launch.egressProfile, exitCheckUrl: profile.exitCheckUrl },
          args: ["-p", "--output-format", "json", ...launch.args] });
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
    return { finished, duplicate: async () => JSON.parse(await runCli(args, deps)), queued };
  };
  return { start, receipts, cwd };
}
