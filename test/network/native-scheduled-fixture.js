import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeRoutineFixture } from "./native-routine-fixture.js";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));

// Real launchd/systemd timer and AIM occurrence/worker/native CLI. Only the
// existing fixture's Herdr UI and Redis wire are substituted. Print mode does
// not claim interactive follow-up, which has its own PTY acceptance case.
export async function verifyOsScheduledRoutine({ root: parentRoot, profile, destination, claudeBin }) {
  const root = path.join(parentRoot, "os-scheduled");
  await fs.mkdir(root);
  const scheduledDate = new Date(Math.ceil((Date.now() + 12000) / 60000) * 60000);
  const routineId = `test-privacy-${process.pid}`;
  const options = { root, profile, destination, claudeBin, routineId };
  const fixture = await createNativeRoutineFixture({ ...options, scheduledDate });
  const receiptPath = path.join(root, "os-receipt.json");
  const aim = path.join(fixture.homeDir, ".local/bin/aim");
  await fs.mkdir(path.dirname(aim), { recursive: true });
  await fs.writeFile(aim, `#!${process.execPath}
import fs from 'node:fs';
import {createNativeRoutineFixture} from ${JSON.stringify(new URL("./native-routine-fixture.js", import.meta.url).href)};
const actualStart=new Date().toISOString(), parentPid=process.ppid, uid=process.getuid(), tty=Boolean(process.stdin.isTTY);
const args=process.argv.slice(2);
if(JSON.stringify(args)!==JSON.stringify(['routine','run',${JSON.stringify(routineId)}])) throw Error('unexpected scheduled entrypoint');
const fixture=await createNativeRoutineFixture({...${JSON.stringify(options)},scheduledDate:new Date(${JSON.stringify(scheduledDate.toISOString())})});
const occurrence=await fixture.start(0,'Run the scheduled synthetic Bash task. ROUTINE_SUCCESS_CANARY.');
const receipt=await occurrence.finished;
fs.writeFileSync(${JSON.stringify(receiptPath)},JSON.stringify({actualStart,parentPid,uid,tty,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,receipt}));
if(receipt.needsAttention) process.exitCode=1;
`, { mode: 0o700 });
  const env = { ...process.env, HOME: fixture.homeDir, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };
  const label = `com.funcountry.aimgr.routine.${routineId}`;
  const unit = `aimgr-privacy-scheduled-${process.pid}`;
  let domain, plist, installedPlist;
  const launchctl = args => domain === "system" ? exec("sudo", ["launchctl", ...args]) : exec("launchctl", args);
  try {
    if (process.platform === "darwin") {
      await exec(process.execPath, [path.join(repo, "scripts/install-routines.mjs"), "--prepare", routineId], { env });
      plist = path.join(fixture.homeDir, ".aimgr/routines/launchagents", `${label}.plist`);
      // A headless EC2 user's background domain has no calendar event agent.
      // Exercise the same rendered calendar/argv/environment in system launchd
      // with UserName dropping to the ordinary test user. This substitution
      // proves unattended native execution, not GUI LaunchAgent activation.
      domain = await exec("launchctl", ["print", `gui/${process.getuid()}`]).then(() => `gui/${process.getuid()}`, () => "system");
      if (domain === "system") {
        await exec("plutil", ["-insert", "UserName", "-string", os.userInfo().username, plist]);
        installedPlist = `/Library/LaunchDaemons/${label}.plist`;
        await exec("sudo", ["install", "-o", "root", "-g", "wheel", "-m", "600", plist, installedPlist]);
      }
      await launchctl(["bootstrap", domain, installedPlist ?? plist]);
    } else {
      const calendar = scheduledDate.toISOString().replace("T", " ").replace(".000Z", " UTC");
      await exec("sudo", ["systemd-run", `--unit=${unit}`, `--on-calendar=${calendar}`, "--timer-property=AccuracySec=1s",
        `--uid=${process.getuid()}`, `--working-directory=${fixture.cwd}`, `--setenv=HOME=${fixture.homeDir}`,
        `--setenv=PATH=${env.PATH}`, aim, "routine", "run", routineId]);
    }
    let result;
    const deadline = scheduledDate.getTime() + 45000;
    while (Date.now() < deadline) {
      try { result = JSON.parse(await fs.readFile(receiptPath, "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(200);
    }
    if (!result) {
      if (process.platform === "darwin") console.error((await launchctl(["print", `${domain}/${label}`]).catch(error => ({ stdout: error.message }))).stdout);
      const logs = path.join(fixture.homeDir, ".aimgr/logs");
      for (const name of await fs.readdir(logs).catch(() => [])) console.error(name, await fs.readFile(path.join(logs, name), "utf8"));
    }
    assert.ok(result, "OS-scheduled AIM occurrence did not produce its receipt");
    assert.equal(result.uid, process.getuid());
    assert.equal(result.tty, false);
    assert.ok(Date.parse(result.actualStart) >= scheduledDate.getTime());
    assert.ok(Date.parse(result.actualStart) - scheduledDate.getTime() < 15000);
    assert.equal(result.receipt.outcome, "completed");
    assert.equal(result.receipt.needsAttention, false);
    assert.equal(result.receipt.selectedAccount.binding, "a");
    assert.equal(await fs.readFile(path.join(fixture.cwd, "tool-proof.txt"), "utf8"), "native-tool-ok");
    const receipt = { scheduler: process.platform === "darwin" ? `launchd ${domain}` : "systemd transient timer",
      expectedStart: scheduledDate.toISOString(), actualStart: result.actualStart, parentPid: result.parentPid,
      timezone: result.timezone, fireKey: result.receipt.fireKey, outcome: result.receipt.outcome,
      selectedAccount: result.receipt.selectedAccount.binding, unattended: true, nativeToolCompleted: true,
      substituted: ["Herdr UI", "Redis wire", "print mode instead of interactive follow-up", ...(domain === "system" ? ["headless system launchd with ordinary UserName; GUI activation not exercised"] : [])] };
    console.log(JSON.stringify({ osScheduledRoutine: receipt }));
    return receipt;
  } finally {
    if (process.platform === "darwin" && domain) await launchctl(["bootout", `${domain}/${label}`]).catch(() => {});
    if (installedPlist) await exec("sudo", ["rm", "--", installedPlist]);
    if (process.platform === "linux") await exec("sudo", ["systemctl", "stop", `${unit}.timer`, `${unit}.service`]).catch(() => {});
  }
}
