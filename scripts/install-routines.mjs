#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAllRoutineDefinitions } from "../src/routines/config.js";
import { resolveAimgrRoutineLogsDir } from "../src/io/paths.js";
import {
  renderRoutineLaunchAgent,
  routineLaunchAgentLabel,
  routineLaunchAgentPath,
  stagedRoutineLaunchAgentPath,
} from "../src/routines/launchd.js";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writeValidatedPlist(routine, { homeDir, aimPath, destination }) {
  const tempPath = `${destination}.${process.pid}.tmp`;
  const plist = renderRoutineLaunchAgent(routine, { homeDir, aimPath });
  ensurePrivateDirectory(path.dirname(destination));
  ensurePrivateDirectory(resolveAimgrRoutineLogsDir({ homeDir }));
  let installed = false;
  try {
    fs.writeFileSync(tempPath, plist, { encoding: "utf8", mode: 0o600 });
    run("plutil", ["-lint", tempPath]);
    fs.renameSync(tempPath, destination);
    installed = true;
  } finally {
    if (!installed) fs.rmSync(tempPath, { force: true });
  }
  fs.chmodSync(destination, 0o600);
}

function prepareRoutine(routine, { homeDir, aimPath }) {
  const destination = stagedRoutineLaunchAgentPath({ homeDir, routineId: routine.id });
  writeValidatedPlist(routine, { homeDir, aimPath, destination });
  return {
    routineId: routine.id,
    label: routineLaunchAgentLabel(routine.id),
    path: destination,
    status: "prepared",
  };
}

function installRoutine(routine, { homeDir, aimPath, domain }) {
  const destination = routineLaunchAgentPath({ homeDir, routineId: routine.id });
  writeValidatedPlist(routine, { homeDir, aimPath, destination });
  run("launchctl", ["bootout", domain, destination], { allowFailure: true });
  run("launchctl", ["bootstrap", domain, destination]);
  return {
    routineId: routine.id,
    label: routineLaunchAgentLabel(routine.id),
    path: destination,
    status: "installed",
  };
}

function uninstallRoutine(routine, { homeDir, domain }) {
  const destination = routineLaunchAgentPath({ homeDir, routineId: routine.id });
  run("launchctl", ["bootout", domain, destination], { allowFailure: true });
  fs.rmSync(destination, { force: true });
  return {
    routineId: routine.id,
    label: routineLaunchAgentLabel(routine.id),
    path: destination,
    status: "uninstalled",
  };
}

function main(argv) {
  const homeDir = process.env.HOME;
  if (!homeDir) fail("HOME is required.");
  if (process.platform !== "darwin" && process.env.AIM_ROUTINES_ALLOW_NON_DARWIN !== "1") {
    fail("AIM routine LaunchAgents are supported only on macOS.");
  }
  const uninstall = argv[0] === "--uninstall";
  const prepare = argv[0] === "--prepare";
  const desktopOffConfirmed = argv.includes("--desktop-off-confirmed");
  const noDesktopCounterpart = argv.includes("--no-desktop-counterpart");
  const usage = "Usage: install-routines.mjs [--prepare|--uninstall] [routine-id...] [--desktop-off-confirmed|--no-desktop-counterpart]";
  if (argv.slice(1).includes("--uninstall") || argv.slice(1).includes("--prepare")) fail(usage);
  if ((prepare || uninstall) && (desktopOffConfirmed || noDesktopCounterpart)) {
    fail("Desktop-counterpart acknowledgement flags are valid only for live install mode.");
  }
  if (desktopOffConfirmed && noDesktopCounterpart) fail(usage);
  const idArgs = argv
    .slice(uninstall || prepare ? 1 : 0)
    .filter((value) => !["--desktop-off-confirmed", "--no-desktop-counterpart"].includes(value));
  if (idArgs.some((value) => value.startsWith("--"))) fail(usage);
  const requestedIds = new Set(idArgs);
  const { routines } = readAllRoutineDefinitions({ homeDir });
  const selected = requestedIds.size
    ? routines.filter((routine) => requestedIds.has(routine.id))
    : routines;
  const missing = [...requestedIds].filter((id) => !selected.some((routine) => routine.id === id));
  if (missing.length) fail(`Unknown routine: ${missing.join(", ")}.`);
  if (selected.length === 0) fail("No configured routines found.");
  if (!prepare && !uninstall && requestedIds.size !== 1) {
    fail("Activate exactly one routine at a time after Amir confirms its Desktop counterpart is off.");
  }
  if (!prepare && !uninstall && noDesktopCounterpart && !selected[0].id.startsWith("test-")) {
    fail("--no-desktop-counterpart is restricted to temporary test-* routines.");
  }
  if (!prepare && !uninstall && !desktopOffConfirmed && !noDesktopCounterpart) {
    fail("Refusing activation without --desktop-off-confirmed or --no-desktop-counterpart.");
  }

  const aimPath = path.join(homeDir, ".local", "bin", "aim");
  if (!uninstall) {
    try {
      fs.accessSync(aimPath, fs.constants.X_OK);
    } catch {
      fail(`Installed AIM executable is unavailable: ${aimPath}`);
    }
  }
  ensurePrivateDirectory(path.join(homeDir, ".aimgr", "routines"));
  const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
  const results = selected.map((routine) => {
    if (uninstall) return uninstallRoutine(routine, { homeDir, domain });
    if (prepare) return prepareRoutine(routine, { homeDir, aimPath });
    return installRoutine(routine, { homeDir, aimPath, domain });
  });
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  fail(String(error?.message ?? error));
}
