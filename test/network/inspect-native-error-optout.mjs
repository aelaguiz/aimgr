// Reproduce the narrow error-reporter proof without an account or an upload.
// Exact binary pin deliberately makes a new Claude version require inspection.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const binary = fs.readFileSync(process.argv[2]);
const binarySha256 = createHash("sha256").update(binary).digest("hex");
assert.equal(binarySha256, "fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824");
const source = binary.toString();
const gate = source.match(/function Z_i\(\)\{if\(process\.env\.DISABLE_ERROR_REPORTING\)[\s\S]*?return l\(\)\}/)?.[0];
assert.ok(gate);
// Source linkage: the logError/unhandled-rejection/uncaught-exception entry
// checks Z_i before enqueueing mts. mts uses HTn's batching sender; that sender
// uses f, which posts to the named Datadog collector. No model body is inspected.
const reportEntry = source.match(/function tSe\([\s\S]*?\}catch\{\}\}/)?.[0];
const enqueue = source.match(/function mts\([\s\S]*?else r\.sender\.enqueue\(e\)\}/)?.[0];
const collector = "https://browser-intake-us5-datadoghq.com/api/v2/logs";
const senderStart = source.lastIndexOf(`var p="${collector}"`);
const senderEnd = source.indexOf("export{HTn,pts,mts,PVi}", senderStart);
const sender = source.slice(senderStart, senderEnd);
assert.match(reportEntry, /if\(!Z_i\(\)\)return;/);
assert.match(reportEntry, /mts\(t\)/);
assert.match(reportEntry, /unhandled_rejection.*uncaught_exception/);
assert.match(enqueue, /let r=HTn\(\)/);
assert.match(sender, /sender=E7r\(\{maxBatchSize:u,getFlushIntervalMs:m,post:f\}\)/);
assert.match(sender, /await Ul\.post\(`\$\{p\}/);
let checks = 0;
const count = value => () => { checks++; return value; };
function evaluate(env) {
  return vm.runInNewContext(`(${gate})()`, { process: { env }, X: count(false), Ey: count(false), Te: count("firstParty"),
    Oi: count(true), r: { gte: count(true), coerce: count({ version: "2.1.316" }) }, n: "0.0.0", ans: count(true), l: count(true) });
}
assert.equal(evaluate({}), true);
checks = 0;
assert.equal(evaluate({ DISABLE_ERROR_REPORTING: "1" }), false);
assert.equal(checks, 0);
console.log(JSON.stringify({ client: "Claude Code 2.1.316 linux x64", binarySha256,
  gateSourceSha256: createHash("sha256").update(gate).digest("hex"),
  entrypoint: "tSe → Z_i → mts → HTn.sender → f", collector,
  positiveEligibleReporterEnabled: true, optedOutReporterEnabled: false, downstreamChecksAfterOptOut: checks,
  method: "Extract and execute the unchanged pinned reporter admission function with eligible prerequisite stubs; verify its collector call chain in shipped source. No live upload or binary modification." }, null, 2));
