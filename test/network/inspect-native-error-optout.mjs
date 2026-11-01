// Reproduce the narrow error-reporter proof without an account or an upload.
// Exact binary pin deliberately makes a new Claude version require inspection.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const binary = fs.readFileSync(process.argv[2]);
const binarySha256 = createHash("sha256").update(binary).digest("hex");
const pins = {
  fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824: { platform: "linux x64", gate: "Z_i", entry: "tSe", enqueue: "mts", state: "HTn", cap: "pts", shutdown: "PVi", batch: "E7r", provider: "Te", eligible: "Oi", compliance: "ans" },
  "64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f": { platform: "darwin arm64", gate: "NSi", entry: "abe", enqueue: "jts", state: "eTn", cap: "Bts", shutdown: "pKi", batch: "wQr", provider: "Ce", eligible: "Ii", compliance: "Dns" },
};
const pin = pins[binarySha256];
assert.ok(pin, "uninspected native Claude binary");
const pattern = value => new RegExp(value.replaceAll("GATE", pin.gate).replaceAll("ENTRY", pin.entry).replaceAll("ENQUEUE", pin.enqueue).replaceAll("STATE", pin.state).replaceAll("BATCH", pin.batch));
const source = binary.toString();
const gate = source.match(pattern(String.raw`function GATE\(\)\{if\(process\.env\.DISABLE_ERROR_REPORTING\)[\s\S]*?return l\(\)\}`))?.[0];
assert.ok(gate);
// Source linkage: the logError/unhandled-rejection/uncaught-exception entry
// checks Z_i before enqueueing mts. mts uses HTn's batching sender; that sender
// uses f, which posts to the named Datadog collector. No model body is inspected.
const reportEntry = source.match(pattern(String.raw`function ENTRY\([\s\S]*?\}catch\{\}\}`))?.[0];
const enqueue = source.match(pattern(String.raw`function ENQUEUE\([\s\S]*?else r\.sender\.enqueue\(e\)\}`))?.[0];
const collector = "https://browser-intake-us5-datadoghq.com/api/v2/logs";
const senderStart = source.lastIndexOf(`var p="${collector}"`);
const senderEnd = source.indexOf(`export{${pin.state},${pin.cap},${pin.enqueue},${pin.shutdown}}`, senderStart);
const sender = source.slice(senderStart, senderEnd);
assert.match(reportEntry, pattern(String.raw`if\(!GATE\(\)\)return;`));
assert.match(reportEntry, pattern(String.raw`ENQUEUE\(t\)`));
assert.match(reportEntry, /unhandled_rejection.*uncaught_exception/);
assert.match(enqueue, pattern(String.raw`let r=STATE\(\)`));
assert.match(sender, pattern(String.raw`sender=BATCH\(\{maxBatchSize:u,getFlushIntervalMs:m,post:f\}\)`));
assert.match(sender, /await Ul\.post\(`\$\{p\}/);
let checks = 0;
const count = value => () => { checks++; return value; };
function evaluate(env) {
  return vm.runInNewContext(`(${gate})()`, { process: { env }, X: count(false), Ey: count(false), [pin.provider]: count("firstParty"),
    [pin.eligible]: count(true), r: { gte: count(true), coerce: count({ version: "2.1.316" }) }, n: "0.0.0", [pin.compliance]: count(true), l: count(true) });
}
assert.equal(evaluate({}), true);
checks = 0;
assert.equal(evaluate({ DISABLE_ERROR_REPORTING: "1" }), false);
assert.equal(checks, 0);
console.log(JSON.stringify({ client: `Claude Code 2.1.316 ${pin.platform}`, binarySha256,
  gateSourceSha256: createHash("sha256").update(gate).digest("hex"),
  entrypoint: `${pin.entry} → ${pin.gate} → ${pin.enqueue} → ${pin.state}.sender → f`, collector,
  positiveEligibleReporterEnabled: true, optedOutReporterEnabled: false, downstreamChecksAfterOptOut: checks,
  method: "Extract and execute the unchanged pinned reporter admission function with eligible prerequisite stubs; verify its collector call chain in shipped source. No live upload or binary modification." }, null, 2));
