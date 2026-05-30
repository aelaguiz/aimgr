import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildLocalMachineInfo, getOrCreateMachineId } from "../../src/coordination/machine.js";
import { resolveAimgrLocalStatePath, resolveAimgrMachineIdPath } from "../../src/io/paths.js";
import { ensureLocalStateShape, loadLocalState, writeLocalState } from "../../src/state/local-state.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

test("machine id is created once and reused", () => {
  const home = mkTempHome();
  const first = getOrCreateMachineId({ homeDir: home });
  const second = getOrCreateMachineId({ homeDir: home });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.machineId, first.machineId);
  assert.equal(first.path, resolveAimgrMachineIdPath({ homeDir: home }));
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
});

test("machine id reader normalizes existing ids", () => {
  const home = mkTempHome();
  const machineIdPath = resolveAimgrMachineIdPath({ homeDir: home });
  fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
  fs.writeFileSync(machineIdPath, " Studio Agent!! \n", "utf8");

  assert.deepEqual(getOrCreateMachineId({ homeDir: home }), {
    machineId: "studio-agent",
    path: machineIdPath,
    created: false,
  });
});

test("local machine info includes stable id and observation metadata", () => {
  const home = mkTempHome();
  const info = buildLocalMachineInfo({
    homeDir: home,
    aimVersion: "1.2.3",
    now: new Date("2026-05-30T14:00:00.000Z"),
  });

  assert.equal(info.aimVersion, "1.2.3");
  assert.equal(info.observedAt, "2026-05-30T14:00:00.000Z");
  assert.equal(info.machineIdPath, resolveAimgrMachineIdPath({ homeDir: home }));
  assert.ok(info.hostname);
  assert.ok(info.platform);
});

test("local state keeps non-credential adjunct state and repairs malformed fields", () => {
  const state = ensureLocalStateShape({
    targets: {
      openclaw: {
        assignments: { agent_boss: "boss" },
        exclusions: null,
      },
    },
    pool: {
      openaiCodex: {
        history: "bad",
        agentDemand: "bad",
        hermesFleet: { demandByHome: "bad" },
      },
      anthropic: {
        history: "bad",
      },
    },
    browserBindings: { boss: { userDataDir: "/tmp/profile" } },
  });

  assert.deepEqual(state.targets.openclaw.assignments, { agent_boss: "boss" });
  assert.deepEqual(state.targets.openclaw.exclusions, {});
  assert.deepEqual(state.pool.openaiCodex.history, []);
  assert.deepEqual(state.pool.openaiCodex.agentDemand, {});
  assert.deepEqual(state.pool.openaiCodex.hermesFleet.demandByHome, {});
  assert.deepEqual(state.pool.anthropic.history, []);
  assert.deepEqual(state.browserBindings, { boss: { userDataDir: "/tmp/profile" } });
});

test("local state round-trips through the new local state file", () => {
  const home = mkTempHome();
  const localStatePath = resolveAimgrLocalStatePath({ homeDir: home });
  writeJson(localStatePath, {
    targets: {
      codexCli: { activeLabel: "boss" },
    },
  });

  const state = loadLocalState({ homeDir: home });
  assert.equal(state.targets.codexCli.activeLabel, "boss");
  const result = writeLocalState({ homeDir: home, localState: state });
  assert.equal(result.path, localStatePath);
  assert.equal(result.wrote, true);
});
