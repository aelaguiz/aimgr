import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { renderRoutineLaunchAgent } from "../../src/routines/launchd.js";
import { validateRoutineDefinition } from "../../src/routines/config.js";
import { mkTempHome } from "../helpers/files.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function definition(home) {
  const cwd = path.join(home, "work");
  const promptFile = path.join(home, "prompt.md");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(promptFile, "safe prompt\n");
  return {
    calendar: [{ hour: 7, minute: 0 }, { hour: 17, minute: 0 }],
    cwd,
    promptFile,
    provider: "anthropic",
    model: "claude-fable-5",
    thinking: "xhigh",
    herdrSession: "growth",
    spaceTitleFormat: "community sweep · {scheduled_local}",
  };
}

test("LaunchAgent renderer emits fixed calendar entries and no RunAtLoad", () => {
  const home = mkTempHome();
  const routine = validateRoutineDefinition("community-sweep", definition(home));
  const plist = renderRoutineLaunchAgent(routine, {
    homeDir: home,
    aimPath: path.join(home, ".local", "bin", "aim"),
  });
  assert.equal((plist.match(/<key>Hour<\/key>/g) ?? []).length, 2);
  assert.match(plist, /<integer>7<\/integer>/);
  assert.match(plist, /<string>com\.funcountry\.aimgr\.routine\.community-sweep<\/string>/);
  assert.match(plist, /<integer>17<\/integer>/);
  assert.doesNotMatch(plist, /RunAtLoad/);
  assert.match(plist, /<string>routine<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.match(plist, /<string>community-sweep<\/string>/);
  assert.match(plist, /\.cargo\/bin/);
  assert.doesNotMatch(plist, /PRIME_AGENT_LAUNCHER_PATH/);
  assert.match(plist, /\.aimgr\/logs\/routine-community-sweep\.out\.log/);
  assert.match(plist, /\.aimgr\/logs\/routine-community-sweep\.err\.log/);
});

test("installer validates, installs, bootstraps, and uninstalls selected static plists", () => {
  const home = mkTempHome();
  const fakeBin = path.join(home, "fake-bin");
  const callsPath = path.join(home, "calls.log");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "bin", "aim"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const name of ["plutil", "launchctl"]) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\nprintf '%s %s\n' '${name}' "$*" >> '${callsPath}'\nexit 0\n`, { mode: 0o755 });
  }
  writeAimgrConfig({
    homeDir: home,
    config: {
      redis: {},
      routines: {
        "community-sweep": definition(home),
        "test-schedule-smoke": definition(home),
      },
    },
  });
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    AIM_ROUTINES_ALLOW_NON_DARWIN: "1",
  };
  const script = path.join(repoRoot, "scripts", "install-routines.mjs");
  const prepare = spawnSync(process.execPath, [script, "--prepare", "community-sweep"], { env, encoding: "utf8" });
  assert.equal(prepare.status, 0, prepare.stderr);
  const prepared = JSON.parse(prepare.stdout);
  assert.equal(prepared.results[0].status, "prepared");
  assert.match(prepared.results[0].path, /\.aimgr\/routines\/launchagents\//);
  assert.equal(fs.statSync(prepared.results[0].path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, ".aimgr", "routines")).mode & 0o777, 0o700);
  const prepareCalls = fs.readFileSync(callsPath, "utf8");
  assert.match(prepareCalls, /plutil -lint/);
  assert.doesNotMatch(prepareCalls, /launchctl/);

  fs.writeFileSync(callsPath, "");
  const activateAll = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(activateAll.status, 1);
  assert.match(activateAll.stderr, /Activate exactly one routine at a time/);
  assert.equal(fs.readFileSync(callsPath, "utf8"), "");

  const unconfirmed = spawnSync(process.execPath, [script, "community-sweep"], { env, encoding: "utf8" });
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /--desktop-off-confirmed/);
  assert.equal(fs.readFileSync(callsPath, "utf8"), "");

  const invalidTestBypass = spawnSync(
    process.execPath,
    [script, "community-sweep", "--no-desktop-counterpart"],
    { env, encoding: "utf8" },
  );
  assert.equal(invalidTestBypass.status, 1);
  assert.match(invalidTestBypass.stderr, /temporary test-\* routines/);
  assert.equal(fs.readFileSync(callsPath, "utf8"), "");

  const testInstall = spawnSync(
    process.execPath,
    [script, "test-schedule-smoke", "--no-desktop-counterpart"],
    { env, encoding: "utf8" },
  );
  assert.equal(testInstall.status, 0, testInstall.stderr);
  const testPlistPath = JSON.parse(testInstall.stdout).results[0].path;
  assert.equal(fs.existsSync(testPlistPath), true);
  const testUninstall = spawnSync(
    process.execPath,
    [script, "--uninstall", "test-schedule-smoke"],
    { env, encoding: "utf8" },
  );
  assert.equal(testUninstall.status, 0, testUninstall.stderr);
  assert.equal(fs.existsSync(testPlistPath), false);

  fs.writeFileSync(callsPath, "");
  const install = spawnSync(
    process.execPath,
    [script, "community-sweep", "--desktop-off-confirmed"],
    { env, encoding: "utf8" },
  );
  assert.equal(install.status, 0, install.stderr);
  const result = JSON.parse(install.stdout);
  assert.equal(result.results[0].status, "installed");
  const plistPath = result.results[0].path;
  assert.equal(fs.statSync(plistPath).mode & 0o777, 0o600);
  const calls = fs.readFileSync(callsPath, "utf8");
  assert.match(calls, /plutil -lint/);
  assert.match(calls, /launchctl bootstrap gui\//);

  const uninstall = spawnSync(process.execPath, [script, "--uninstall", "community-sweep"], { env, encoding: "utf8" });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.existsSync(plistPath), false);
});
