import assert from "node:assert/strict";
import path from "node:path";
import { createNativeRoutineFixture } from "./native-routine-fixture.js";

export async function verifyRoutineConcurrency({ root, profileB, destination, claudeBin, runningA, routineA, modelRequests }) {
  const requestsBefore = modelRequests.length;
  assert.equal((await runningA.duplicate()).outcome, "duplicate");
  assert.equal((await runningA.attemptOverlap()).outcome, "overlap");
  assert.equal(modelRequests.length, requestsBefore);
  const b = await createNativeRoutineFixture({ root: path.join(root, "concurrent-b"), label: "b", profile: profileB, destination, claudeBin });
  const doneB = await (await b.start(0, "ROUTINE_SUCCESS_CANARY SCHEDULE_B_CANARY")).finished;
  assert.equal(doneB.outcome, "completed");
  assert.equal(doneB.selectedAccount.binding, "b");
  assert.equal((await runningA.attemptOverlap()).outcome, "overlap", "A remains active after B completes");
  // Existing AIM maintenance defers while a caller holds the credential lease.
  // Preserve that behavior and prove the active scheduled caller survives it.
  await routineA.maintain(false, true);
  assert.equal((await runningA.attemptOverlap()).outcome, "overlap");
  console.log(JSON.stringify({ scheduledConcurrency: { bCompletesWhileAWaits: true, duplicate: "duplicate", overlap: "overlap" } }));
}

export async function verifyScheduledStartupFailure({ root, profile, profileB, destination, ordinaryDestination = destination, claudeBin, modelRequests, phase = "down" }) {
  const failed = await createNativeRoutineFixture({ root: path.join(root, `failed-scheduled-start-${phase}`), profile, destination, claudeBin });
  const occurrence = await failed.start(0, "SCHEDULE_MUST_NOT_START_CANARY");
  const receipt = await occurrence.finished;
  assert.equal(receipt.needsAttention, true);
  assert.ok(receipt.exitCode > 0);
  assert.ok(failed.receipts[0].exitCode > 0);
  assert.ok(receipt.error.includes(profile.profileRef), receipt.error);
  assert.match(receipt.error, /Claude a.*(?:Repair|repair)/);
  assert.equal(receipt.prompt.admittedAt, null);
  assert.equal(modelRequests.some(body => JSON.stringify(body).includes("SCHEDULE_MUST_NOT_START_CANARY")), false);
  assert.equal((await occurrence.duplicate()).outcome, "duplicate");
  await failed.maintain(true);
  for (const [label, selected, marker] of [["b", profileB, "SCHEDULE_B_CANARY"], ["ordinary", null, "SCHEDULE_ORDINARY_CANARY"]]) {
    const healthy = await createNativeRoutineFixture({ root: path.join(root, `scheduled-outage-${label}-${phase}`), label, profile: selected,
      destination: selected ? destination : ordinaryDestination, claudeBin });
    const done = await (await healthy.start(0, `ROUTINE_SUCCESS_CANARY ${marker}`)).finished;
    assert.equal(done.outcome, "completed");
    assert.equal(done.selectedAccount.binding, label);
  }
  console.log(JSON.stringify({ scheduledStartupFailure: { phase, persistedError: receipt.error, promptAdmitted: false,
    modelRequests: 0, exitCode: receipt.exitCode, healthyBCompleted: true, ordinaryCompleted: true, duplicate: "duplicate" } }));
  return occurrence;
}

export function assertScheduledModelRoutes(modelRequests, modelRoutes, ordinaryAddress) {
  for (let index = 0; index < modelRequests.length; index++) {
    const text = JSON.stringify(modelRequests[index].messages);
    const expected = text.includes("SCHEDULE_B_CANARY") ? "127.0.0.3" : text.includes("SCHEDULE_ORDINARY_CANARY") ? ordinaryAddress : "127.0.0.2";
    assert.equal(modelRoutes[index], expected, "every native and scheduled model turn uses its selected account's route");
  }
}
