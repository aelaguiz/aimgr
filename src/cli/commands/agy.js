import {
  assertAgyRouteMatches,
  enrollAgyConnection,
  readAgyConnection,
  withAgyConnection,
} from "../../credentials/agy-local.js";
import { inspectAgyRuntime } from "../../privacy/agy-artifacts.js";
import { runAgyNative } from "../../privacy/agy-native-invocation.js";
import { readAimgrConfig } from "../../config/aimgr-config.js";
import { ensureAgyAccountMetadata } from "../../coordination/agy-metadata.js";
import { closeRedisStore, connectRedisStore } from "../../coordination/redis-store.js";
import { agyProfileRef } from "../../network/agy-native-route.js";
import { readLocalAgyStatus } from "../../status/agy-view.js";
import { clearAgyObservation, writeAgyUsageCache } from "../../status/agy-observation.js";
import { collectAgyUsageStatus, refreshAgyUsage } from "../../status/agy-usage.js";
import { renderLocalAgyStatusLines } from "../../status/table.js";

const conversationId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function publishEnrollment(redis, label, connectRedisStoreImpl = connectRedisStore) {
  let store;
  try {
    store = await connectRedisStoreImpl(redis);
    await ensureAgyAccountMetadata(store, { label });
    return true;
  } catch {
    return false;
  } finally {
    await closeRedisStore(store).catch(() => {});
  }
}

export async function handleAgy(context) {
  const { argv, opts, positional, env, stdout, stderr, setExitCode, cwd = process.cwd(), homeDir, nowMs = Date.now() } = context;
  const [, operation, label, ...extra] = positional;
  const autoSelect = operation === "run" && label === undefined;
  const privacy = operation === "privacy";
  const resume = operation === "resume";
  const logout = operation === "logout";
  if (privacy && label !== "status") throw new Error("Usage: aim agy privacy status [--json]");
  if (!["login", "status", "refresh", "run", "resume", "logout", "privacy"].includes(operation)
      || (label === undefined && operation !== "status" && !autoSelect) || extra.length !== Number(resume)) {
    throw new Error("Use `aim agy login <label>`, `aim agy status [<label>] [--json]`, `aim agy refresh <label>`, `aim agy run [label] [-- --print <prompt>]`, `aim agy resume <label> <conversation-id> [-- --print <prompt>]`, or `aim agy logout <label>`.");
  }
  const [sessionId] = extra;
  if (resume && !conversationId.test(sessionId)) throw new Error("Antigravity resume needs the native conversation UUID.");
  for (let i = 0; i < argv.length && argv[i] !== "--"; i += 1) {
    const argument = argv[i];
    if (argument === "--home" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      i += 1;
    } else if (argument.startsWith("-") && !(argument === "--json" && (operation === "status" || privacy))) {
      throw new Error("Use `--json` with Antigravity status and put native launch arguments after `--`.");
    }
  }
  if (operation !== "run" && !resume && opts.afterDoubleDash.length) {
    throw new Error("Put native Antigravity arguments after `--` on `aim agy run` or `aim agy resume`.");
  }
  if (privacy) {
    const report = inspectAgyRuntime();
    if (opts.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (report.runtime) stdout.write(`Antigravity ${report.runtime.version} is approved for this release.\n`);
    else stdout.write(`${report.refusal ?? "Antigravity requires Linux x64 or macOS arm64."}\n`);
    return;
  }
  const { config } = readAimgrConfig({ homeDir });
  const usageOptions = { homeDir, config, env, nowMs, runAgyNativeImpl: context.runAgyNativeImpl,
    readLocalAgyStatusImpl: context.readLocalAgyStatusImpl };
  if (operation === "status") {
    const report = await collectAgyUsageStatus({ ...usageOptions, label });
    stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderLocalAgyStatusLines(report, nowMs).join("\n")}\n`);
    return;
  }

  const runNative = context.runAgyNativeImpl ?? runAgyNative;
  const invocation = { operation, cwd, homeDir, config, env, stdout, stderr };
  if (operation === "login") {
    const { redis } = config;
    const { alreadyEnrolled, archiveName } = await enrollAgyConnection(homeDir, label, async (accountHome, profileRef) => {
      const result = await runNative({ ...invocation, label, profileRef, accountHome, args: [] });
      if (result?.exitCode !== 0 || typeof result.account !== "string" || !result.account.trim()) {
        throw new Error(`Antigravity sign-in did not verify a Google account. Run \`aim agy login ${label}\` to try again.`);
      }
    }, { profileRef: agyProfileRef(config, label) });
    let local = `Enrolled Antigravity connection ${label} locally.`;
    if (alreadyEnrolled) local = `Antigravity connection ${label} is already enrolled locally.`;
    else if (archiveName) local = `Signed in to Antigravity connection ${label} with a fresh local home.`;
    if (archiveName) local += ` Previous local history was kept at \`.aimgr/agy/${archiveName}\` under the selected home.`;
    if (!redis.url) {
      stdout.write(`${local} The shared roster is unavailable because Redis is unconfigured.\n`);
    } else if (await publishEnrollment(redis, label, context.connectRedisStoreImpl)) {
      stdout.write(`${local} The label is in the shared roster.\n`);
    } else {
      stdout.write(`${local} The shared roster is unavailable. Run \`aim agy login ${label}\` to retry roster publication.\n`);
    }
    return;
  }

  async function useConnection(connection) {
    const { label } = connection;
    if (autoSelect && connection.status !== "ready") return;
    if (connection.status === "not-enrolled") throw new Error(`Run \`aim agy login ${label}\` to enroll this connection.`);
    if (connection.status === "needs-sign-in") {
      if (logout) {
        stdout.write(`Antigravity connection ${label} is signed out locally.\n`);
        return;
      }
      throw new Error(`Antigravity connection ${label} is signed out. Run \`aim agy login ${label}\` to sign in.`);
    }
    if (connection.status !== "ready") throw new Error(`Antigravity connection ${label} has invalid local state.`);
    const { accountHome, profileRef } = connection;
    assertAgyRouteMatches(label, agyProfileRef(config, label), profileRef);
    if (operation === "refresh") {
      writeAgyUsageCache(accountHome, await refreshAgyUsage(connection, usageOptions));
      return;
    }
    if (autoSelect) stderr.write(`Using Antigravity account ${label}.\n`);
    const result = await runNative({ ...invocation, label, profileRef, accountHome, sessionId, args: opts.afterDoubleDash });
    if (result?.exitCode !== 0) {
      setExitCode(Number.isInteger(result?.exitCode) ? result.exitCode : 1);
    } else if (logout) {
      if (readAgyConnection(homeDir, label).status !== "needs-sign-in") {
        throw new Error(`Antigravity did not clear the local grant for ${label}.`);
      }
      clearAgyObservation(accountHome);
      stdout.write(`Antigravity connection ${label} signed out.\n`);
    }
    return true;
  }
  if (autoSelect) {
    const readStatus = context.readLocalAgyStatusImpl ?? readLocalAgyStatus;
    const { connections } = readStatus(homeDir, { config });
    const ready = connections.filter(row => row.availability === "ready");
    // Vary the starting account so equally available accounts share fresh sessions.
    const start = Math.floor(Math.random() * ready.length);
    for (let offset = 0; offset < ready.length; offset += 1) {
      const candidate = ready[(start + offset) % ready.length];
      if (await withAgyConnection(homeDir, candidate.label, useConnection, { skipBusy: true })) return;
    }
    throw new Error("No Antigravity account is available on this machine. Run `aim agy status` to see why, or `aim agy login <label>` to add an account.");
  }
  await withAgyConnection(homeDir, label, useConnection);
  if (operation === "refresh") {
    const report = readLocalAgyStatus(homeDir, { config, label });
    stdout.write(`${renderLocalAgyStatusLines(report, nowMs).join("\n")}\n`);
  }
}
