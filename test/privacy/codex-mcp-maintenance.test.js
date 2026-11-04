import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maintenanceOwners, maintenanceControllers, guardedRoutineLauncher, verifyLoadedRoutine } from "../../src/credentials/codex-mcp-maintenance-owner.js";

const process = (pid, image, args = [], parent = 1) => ({ pid, parent, image, args, birth: String(pid), environment: {} });
test("one-time conversion includes reload-capable Codex but leaves other providers and routines alone", () => {
  const values = [process(10, "/bin/zsh"),
    process(11, "/opt/codex", ["codex"], 10),
    process(12, "/opt/claude", ["claude"], 10),
    process(13, "/opt/node", ["node", "/repo/aimgr/bin/aim.js", "routine", "run", "claude-review"], 10),
    process(14, "/opt/node", ["node", "/repo/aimgr/bin/aim.js", "routine", "run", "codex-review"], 10),
    process(15, "/opt/prime-agent", ["prime-agent"], 10)];
  assert.deepEqual(maintenanceOwners(values, 99, ["codex-review"]).map(p => p.pid), [14, 11]);
});
test("an IDE parent is an uncontrolled relauncher, not proof that inventory is quiet", () => {
  assert.throws(() => maintenanceOwners([process(10, "/Applications/Editor.app/Contents/MacOS/Editor"),
    process(11, "/opt/codex", ["codex", "app-server"], 10)], 99), /external Codex launcher/);
});
test("maintenance refuses to terminate its own Codex ancestor", () => {
  assert.throws(() => maintenanceOwners([process(10, "/opt/codex"), process(11, "/bin/zsh", [], 10),
    process(12, "/opt/node", [], 11)], 12), /terminal outside/);
});
test("updater cancellation precedes exact installer descendants, without selecting ordinary background tools", () => {
  const values = [process(10, "/opt/codex", ["codex", "app-server", "daemon", "pid-update-loop"]),
    process(11, "/bin/sh", ["sh", "/tmp/installer"], 10), process(12, "/usr/bin/curl", [], 11),
    process(13, "/opt/codex", ["codex"]), process(14, "/bin/sleep", ["sleep", "30"], 13)];
  const selected = maintenanceOwners(values, 99).map(p => p.pid);
  assert.equal(selected[0], 10);
  assert.ok(selected.includes(11) && selected.includes(12) && selected.includes(13));
  assert.ok(!selected.includes(14));
});
test("a shell loop or script cannot relaunch a native owner after the final inventory", () => {
  for (const args of [["sh", "-c", "while :; do codex; sleep 2; done"], ["bash", "/tmp/runner.sh"], ["sh", "-s"]]) {
    assert.throws(() => maintenanceOwners([process(10, "/bin/sh", args),
      process(11, "/opt/codex", ["codex"], 10)], 99), /external Codex launcher/);
  }
  assert.deepEqual(maintenanceOwners([process(10, "/bin/zsh", ["-zsh", "-il"]),
    process(11, "/opt/codex", ["codex"], 10)], 99).map(p => p.pid), [11]);
});
test("an unlinked Linux native image remains an owner and preserves its exact stop identity", () => {
  const image = "/opt/old/codex (deleted)";
  const selected = maintenanceOwners([process(11, image, ["codex"])], 99);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].image, image);
});
test("unproved token consumers and pre-upgrade AIM launchers are never selected for TERM", () => {
  for (const owner of [process(11, "/opt/codex", ["codex", "exec", "task"]),
    process(12, "/opt/node", ["node", "/repo/aimgr/bin/aimgr.js", "codex", "run"]),
    process(13, "/opt/node", ["node", "/repo/aimgr/bin/aimgr.js", "routine", "__execute", "codex-review"])]) {
    assert.throws(() => maintenanceControllers([owner], 99, ["codex-review"]), /finish or exit normally/);
  }
});
test("only exact updater and installer lifetimes can be stopped, including reparented known descendants", () => {
  const updater = process(10, "/opt/codex", ["codex", "app-server", "daemon", "pid-update-loop"]);
  const shell = process(11, "/bin/sh", ["sh", "-s"], 10);
  const selected = maintenanceControllers([updater, shell], 99);
  const retained = selected.map(({pid, image, birth}) => ({pid, image, birth}));
  assert.deepEqual(maintenanceControllers([{...shell, parent:1}], 99, [], retained).map(p => p.pid), [11]);
  assert.throws(() => maintenanceControllers([{...shell, parent:1, birth:"reused"}], 99, [], retained), /unidentified shell installer/);
  const restarted = {...process(12, "/opt/codex", ["codex", "app-server"], 11), native_installer:true};
  assert.throws(() => maintenanceControllers([updater, shell, restarted], 99), /finish or exit normally/);
});
test("installer path names cannot capture unrelated providers and hidden orphan scripts refuse", () => {
  assert.deepEqual(maintenanceControllers([process(10, "/bin/sh", ["sh", "/repo/aimgr-codex-m1/install-claude.sh"])], 99), []);
  assert.throws(() => maintenanceControllers([process(11, "/bin/sh", ["sh", "-s"])], 99), /unidentified shell installer/);
  assert.deepEqual(maintenanceControllers([{...process(11, "/bin/sh", ["sh", "-s"]), environment_visible:true}], 99), []);
  assert.deepEqual(maintenanceControllers([{...process(11, "/bin/sh", ["sh", "-s"]), native_installer:true}], 99).map(p => p.pid), [11]);
});
test("a visible shell relaunch loop refuses even between its native children", () => {
  assert.throws(() => maintenanceControllers([process(10, "/bin/sh", ["sh", "-c", "while :; do /opt/codex exec task; sleep 30; done"])], 99), /external Codex shell launcher/);
});

test("only the current CLI or its exact installed wrapper proves the early guard", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-guarded-launcher-"));
  const cli = fileURLToPath(new URL("../../bin/aimgr.js", import.meta.url));
  const wrapper = path.join(root, "aim");
  try {
    const launchPath = path.dirname(globalThis.process.execPath) + ":/usr/bin:/bin";
    assert.equal(guardedRoutineLauncher(cli, launchPath).real, fs.realpathSync(cli));
    const body = `#!/usr/bin/env bash\nset -euo pipefail\nexec "${globalThis.process.execPath}" "${cli}" "$@"\n`;
    fs.writeFileSync(wrapper, body);
    assert.equal(guardedRoutineLauncher(wrapper, launchPath).real, fs.realpathSync(wrapper));
    const shadow = path.join(root, "bash");
    fs.writeFileSync(shadow, "#!/bin/sh\nexit 0\n", {mode:0o700});
    assert.throws(() => guardedRoutineLauncher(wrapper, root+":"+launchPath), /different interpreter/);
    fs.writeFileSync(wrapper, body.replace(cli, path.join(root, "old-aimgr.js")));
    fs.copyFileSync(cli, path.join(root, "old-aimgr.js"));
    assert.throws(() => guardedRoutineLauncher(wrapper, launchPath), /another AIM installation/);
    fs.writeFileSync(wrapper, body.replace('exec "', 'echo bypass\nexec "'));
    assert.throws(() => guardedRoutineLauncher(wrapper, launchPath), /another AIM installation/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("loaded service identity, home and calendar must agree with the reviewed disk definition", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-loaded-definition-"));
  const file = path.join(root, "job.plist");
  fs.writeFileSync(file, "synthetic");
  const definition = { Label:"fixture", ProgramArguments:["/opt/aim", "routine", "run", "fixture"],
    EnvironmentVariables:{ HOME:root, PATH:"/usr/bin:/bin" }, WorkingDirectory:root,
    StandardOutPath:root+"/out", StandardErrorPath:root+"/err", StartCalendarInterval:{Hour:23,Minute:59} };
  const lines = [`user/501/fixture = {`, `\tpath = ${file}`, `\tprogram = /opt/aim`, "\targuments = {",
    ...definition.ProgramArguments.map(v=>"\t\t"+v), "\t}", `\tworking directory = ${root}`,
    `\tstdout path = ${root}/out`, `\tstderr path = ${root}/err`, "\tenvironment = {", "\t\tOSLogRateLimit => 64",
    `\t\tHOME => ${root}`, "\t\tPATH => /usr/bin:/bin", "\t\tXPC_SERVICE_NAME => fixture", "\t}",
    "\tevent triggers = {", "\t\tfixture.123 => {", "\t\t\tstream = com.apple.launchd.calendarinterval",
    "\t\t\tdescriptor = {", '\t\t\t\t"Minute" => 59', '\t\t\t\t"Hour" => 23', "\t\t\t}", "\t\t}", "\t}",
    "\tproperties = inferred program", "}"];
  const text = lines.join("\n"), schedule = {file,definition};
  try {
    verifyLoadedRoutine(schedule,text);
    for (const changed of [text.replace("\tprogram = /opt/aim", "\tprogram = /old/aim"),
      text.replace(`\t\tHOME => ${root}`, "\t\tHOME => /another/home"),
      text.replace('"Minute" => 59','"Minute" => 58'),
      text.replace("\t\troutine", "\t\tcodex"),
      text.replace("\tproperties", "\tinherited environment = {\n\t\tNODE_OPTIONS => --require /old.js\n\t}\n\tproperties"),
      text.replace("\tproperties", "\trun interval = 1 seconds\n\tproperties")]) {
      assert.throws(() => verifyLoadedRoutine(schedule, changed), /loaded Codex schedule/);
    }
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});
