import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runClaudeCli } from "../../src/targets/claude-runner.js";
import { installFixtureSecurityAdapter } from "./native-routine-fixture.js";

export async function verifyNativeProcessControl({ root, profile }) {
  installFixtureSecurityAdapter(root);
  const proof = path.join(root, "control-proof.json"), ticks = path.join(root, "control-ticks");
  const command = path.join(root, "control-claude.mjs");
  await fs.writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({pid:process.pid,uid:process.getuid(),cwd:process.cwd(),custom:process.env.AIMGR_CONTROL_CANARY}));setInterval(()=>fs.appendFileSync(${JSON.stringify(ticks)},'x'),40);`, { mode: 0o700 });
  const configDir = path.join(root, ".aimgr/claude-homes/control/.claude");
  const controller = new AbortController();
  let control;
  const running = runClaudeCli({ command, userHomeDir: root, homeDir: path.dirname(configDir), configDir, cwd: root,
    env: { ...process.env, AIMGR_CONTROL_CANARY: "preserved" }, egressProfile: profile, signal: controller.signal,
    registerProcessControl: value => { control = value; } });
  running.catch(() => {});
  try {
    let observed;
    for (let n = 0; n < 100; n++) {
      try { observed = JSON.parse(await fs.readFile(proof, "utf8")); break; } catch {}
      await delay(30);
    }
    assert.ok(observed);
    assert.equal(observed.uid, process.getuid());
    assert.equal(observed.cwd, root);
    assert.equal(observed.custom, "preserved");
    await delay(100);
    assert.equal(await control.pause(), true);
    const paused = await fs.readFile(ticks, "utf8");
    await delay(150);
    assert.equal(await fs.readFile(ticks, "utf8"), paused);
    assert.equal(await control.resume(), true);
    await delay(100);
    assert.ok((await fs.readFile(ticks, "utf8")).length > paused.length);
    controller.abort();
    const stopped = await running;
    assert.ok(stopped.status !== 0 || stopped.signal);
    assert.throws(() => process.kill(observed.pid, 0), { code: "ESRCH" });
    return { pauseAcknowledged: true, pausedWorkStopped: true, resumeAcknowledged: true, cancellationStoppedChild: true };
  } finally {
    controller.abort();
    await running;
  }
}
