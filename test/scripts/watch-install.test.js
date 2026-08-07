import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o755 });
}

function installFakeCommands(binDir, { osName = "Linux", systemctlLogPath, launchctlLogPath } = {}) {
  writeExecutable(path.join(binDir, "uname"), `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(osName)}\n`);
  if (systemctlLogPath) {
    writeExecutable(
      path.join(binDir, "systemctl"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLogPath)}\nexit 0\n`,
    );
  }
  if (launchctlLogPath) {
    writeExecutable(
      path.join(binDir, "launchctl"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(launchctlLogPath)}\nexit 0\n`,
    );
  }
}

function runInstaller(scriptName, args, { env = {} } = {}) {
  return spawnSync("bash", [path.join("scripts", scriptName), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

test("watch installers render one-shot Linux services in print-only mode", () => {
  const root = mkTempDir("aimgr-watch-print-");
  const fakeBin = path.join(root, "bin");
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  installFakeCommands(fakeBin);

  const env = {
    AIMGR_WATCH_INSTALL_ROOT: path.join(root, "scheduler-root"),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
  };
  const user = os.userInfo().username;
  const baseArgs = [
    "--print-only",
    "--user",
    user,
    "--home",
    home,
    "--workspace-dir",
    workspace,
    "--node-bin",
    process.execPath,
    "--interval-seconds",
    "123",
    "--threshold-pct",
    "17",
  ];

  // The Codex watch installer is deleted with `aim codex use/watch`; Hermes
  // remains the only watch scheduler surface.
  assert.equal(fs.existsSync(path.join("scripts", "install-codex-watch.sh")), false);

  const hermes = runInstaller("install-hermes-watch.sh", baseArgs, { env });
  assert.equal(hermes.status, 0, hermes.stderr);
  assert.match(hermes.stdout, /# Linux systemd service/);
  assert.match(hermes.stdout, /Unit=aim-hermes-watch\.service/);
  assert.match(hermes.stdout, /OnUnitActiveSec=123s/);
  assert.ok(hermes.stdout.includes(`${process.execPath} ${path.join(process.cwd(), "bin", "aimgr.js")} hermes watch --once`));
  assert.ok(hermes.stdout.includes(`--rotate-below-5h-remaining-pct 17 --home ${home}`));
});

test("watch status does not require Node and reads only the temp scheduler root", () => {
  const root = mkTempDir("aimgr-watch-status-");
  const fakeBin = path.join(root, "bin");
  const home = path.join(root, "home");
  const schedulerRoot = path.join(root, "scheduler-root");
  const systemctlLogPath = path.join(root, "systemctl.log");
  fs.mkdirSync(home, { recursive: true });
  installFakeCommands(fakeBin, { systemctlLogPath });

  const result = runInstaller(
    "install-hermes-watch.sh",
    [
      "--status",
      "--user",
      os.userInfo().username,
      "--home",
      home,
      "--node-bin",
      path.join(root, "missing-node"),
    ],
    {
      env: {
        AIMGR_WATCH_INSTALL_ROOT: schedulerRoot,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    },
  );

  // Status is a read-only inspection path. It must not become impossible just
  // because Node was removed, and it must not fall through to production scheduler paths.
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(`Not installed: ${schedulerRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/etc/systemd/system/aim-hermes-watch\\.service`),
  );
  assert.doesNotMatch(result.stderr, /Missing Node binary/);
  assert.equal(fs.existsSync(systemctlLogPath), false);
});

test("watch status uses fake systemctl only when temp-root units exist", () => {
  const root = mkTempDir("aimgr-watch-status-installed-");
  const fakeBin = path.join(root, "bin");
  const home = path.join(root, "home");
  const schedulerRoot = path.join(root, "scheduler-root");
  const systemdDir = path.join(schedulerRoot, "etc", "systemd", "system");
  const systemctlLogPath = path.join(root, "systemctl.log");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(systemdDir, { recursive: true });
  fs.writeFileSync(path.join(systemdDir, "aim-hermes-watch.service"), "[Service]\n", "utf8");
  fs.writeFileSync(path.join(systemdDir, "aim-hermes-watch.timer"), "[Timer]\n", "utf8");
  installFakeCommands(fakeBin, { systemctlLogPath });

  const result = runInstaller(
    "install-hermes-watch.sh",
    [
      "--status",
      "--user",
      os.userInfo().username,
      "--home",
      home,
      "--node-bin",
      path.join(root, "missing-node"),
    ],
    {
      env: {
        AIMGR_WATCH_INSTALL_ROOT: schedulerRoot,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    },
  );

  // Installed-status proof must stay inside fake systemctl and temp unit files;
  // otherwise a harmless audit check can inspect the host scheduler by accident.
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Missing Node binary/);
  assert.equal(fs.readFileSync(systemctlLogPath, "utf8").trim(), "status aim-hermes-watch.timer --no-pager");
});

test("watch uninstall removes only temp-root scheduler files and does not require Node", () => {
  const root = mkTempDir("aimgr-watch-uninstall-");
  const fakeBin = path.join(root, "bin");
  const home = path.join(root, "home");
  const schedulerRoot = path.join(root, "scheduler-root");
  const systemdDir = path.join(schedulerRoot, "etc", "systemd", "system");
  const servicePath = path.join(systemdDir, "aim-hermes-watch.service");
  const timerPath = path.join(systemdDir, "aim-hermes-watch.timer");
  const systemctlLogPath = path.join(root, "systemctl.log");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(systemdDir, { recursive: true });
  fs.writeFileSync(servicePath, "[Service]\n", "utf8");
  fs.writeFileSync(timerPath, "[Timer]\n", "utf8");
  installFakeCommands(fakeBin, { systemctlLogPath });

  const result = runInstaller(
    "install-hermes-watch.sh",
    [
      "--uninstall",
      "--user",
      os.userInfo().username,
      "--home",
      home,
      "--node-bin",
      path.join(root, "missing-node"),
    ],
    {
      env: {
        AIMGR_WATCH_INSTALL_ROOT: schedulerRoot,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    },
  );

  // The sandbox root is the proof boundary: uninstall may remove temp scheduler
  // files and call fake systemctl, but must not require Node or reach real systemd paths.
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(servicePath), false);
  assert.equal(fs.existsSync(timerPath), false);
  assert.ok(result.stdout.includes(`Removed ${servicePath} and ${timerPath}`));
  const systemctlCalls = fs.readFileSync(systemctlLogPath, "utf8").trim().split("\n");
  assert.deepEqual(systemctlCalls, [
    "disable --now aim-hermes-watch.timer",
    "stop aim-hermes-watch.service",
    "daemon-reload",
  ]);
});

test("watch launchd status and uninstall stay inside temp scheduler roots", () => {
  const root = mkTempDir("aimgr-watch-launchd-");
  const fakeBin = path.join(root, "bin");
  const home = path.join(root, "home");
  const schedulerRoot = path.join(root, "scheduler-root");
  const label = "com.funcountry.agents_host.aim_hermes_watch";
  const plistPath = path.join(schedulerRoot, "Library", "LaunchDaemons", `${label}.plist`);
  const legacySystemAgent = path.join(schedulerRoot, "Library", "LaunchAgents", `${label}.plist`);
  const legacyUserAgent = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const launchctlLogPath = path.join(root, "launchctl.log");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(legacySystemAgent), { recursive: true });
  fs.mkdirSync(path.dirname(legacyUserAgent), { recursive: true });
  fs.writeFileSync(plistPath, "<plist />\n", "utf8");
  fs.writeFileSync(legacySystemAgent, "<plist />\n", "utf8");
  fs.writeFileSync(legacyUserAgent, "<plist />\n", "utf8");
  installFakeCommands(fakeBin, { osName: "Darwin", launchctlLogPath });

  const env = {
    AIMGR_WATCH_INSTALL_ROOT: schedulerRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
  };
  const commonArgs = [
    "--user",
    os.userInfo().username,
    "--home",
    home,
    "--node-bin",
    path.join(root, "missing-node"),
  ];

  const status = runInstaller("install-hermes-watch.sh", ["--status", ...commonArgs], { env });
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stderr, /Missing Node binary/);
  assert.equal(fs.readFileSync(launchctlLogPath, "utf8").trim(), `print system/${label}`);

  const uninstall = runInstaller("install-hermes-watch.sh", ["--uninstall", ...commonArgs], { env });
  // Launchd cleanup reaches several service aliases. With the temp root and fake
  // launchctl, the audit can prove those removals without touching host LaunchDaemons.
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.existsSync(plistPath), false);
  assert.equal(fs.existsSync(legacySystemAgent), false);
  assert.equal(fs.existsSync(legacyUserAgent), false);
  assert.ok(uninstall.stdout.includes(`Removed ${plistPath}`));
  const launchctlCalls = fs.readFileSync(launchctlLogPath, "utf8").trim().split("\n");
  assert.deepEqual(launchctlCalls.slice(1), [
    `bootout gui/${process.getuid()}/${label}`,
    `disable gui/${process.getuid()}/${label}`,
    `bootout gui/${process.getuid()} ${legacyUserAgent}`,
    `bootout gui/${process.getuid()} ${legacySystemAgent}`,
    `bootout system ${plistPath}`,
    `bootout system/${label}`,
    `disable system/${label}`,
  ]);
});
