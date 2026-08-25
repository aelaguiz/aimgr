import test from "node:test";
import assert from "node:assert/strict";
import { AIM_MCP_ALLOWED_COMMANDS, validateAimArgv } from "../../src/mcp/policy.js";

test("every allowlisted aim command is callable over MCP", () => {
  for (const command of AIM_MCP_ALLOWED_COMMANDS) {
    assert.deepEqual(validateAimArgv([command]), { ok: true }, `${command} should be allowed`);
  }
  assert.deepEqual(validateAimArgv(["status", "--json"]), { ok: true });
  assert.deepEqual(validateAimArgv(["claude", "status", "--json"]), { ok: true });
  assert.deepEqual(validateAimArgv(["routine", "run", "morning", "--manual"]), { ok: true });
});

test("interactive credential lanes are rejected with the reason the agent needs", () => {
  // These would sit on a browser, a TTY, or a stdio protocol forever. The MCP
  // client has none of those, so the rejection has to say why and what owns it.
  const login = validateAimArgv(["login", "boss"]);
  assert.equal(login.ok, false);
  assert.match(login.reason, /interactive OAuth/);
  assert.match(login.reason, /Phase 2/);

  const helper = validateAimArgv(["credential-helper"]);
  assert.equal(helper.ok, false);
  assert.match(helper.reason, /machine stdin\/stdout protocol/);

  for (const argv of [["claude", "run", "boss"], ["claude", "resume", "3"], ["prime", "run", "codex"], ["prime", "resume", "abc"]]) {
    const verdict = validateAimArgv(argv);
    assert.equal(verdict.ok, false, `${argv.join(" ")} should be rejected`);
    assert.match(verdict.reason, /interactive TUI/);
  }
});

test("an unknown first token is the label panel, not a command", () => {
  const verdict = validateAimArgv(["boss"]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /interactive label panel/);
  assert.match(verdict.reason, /\["help"\]/);

  // `repair` reads like a command but is not one: label repair is `aim label rebind`,
  // so a bare `repair` would sit in the label/login lane until the timeout kills it.
  assert.equal(AIM_MCP_ALLOWED_COMMANDS.includes("repair"), false);
  const repair = validateAimArgv(["repair"]);
  assert.equal(repair.ok, false);
  assert.match(repair.reason, /Unknown aim command: repair/);
});

test("watch loops are rejected until they are one-shot", () => {
  for (const command of ["codex", "hermes"]) {
    const looping = validateAimArgv([command, "watch"]);
    assert.equal(looping.ok, false);
    assert.match(looping.reason, /loops forever/);
    assert.match(looping.reason, new RegExp(`\\["${command}","watch","--once"\\]`));
    assert.deepEqual(validateAimArgv([command, "watch", "--once"]), { ok: true });
    assert.deepEqual(validateAimArgv([command, "watch", "--once", "--interval-seconds", "60"]), { ok: true });
  }
  assert.deepEqual(validateAimArgv(["codex", "use"]), { ok: true });
});

test("malformed argv is rejected before anything is spawned", () => {
  for (const argv of [undefined, null, "status", { argv: ["status"] }]) {
    const verdict = validateAimArgv(argv);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /array of strings/);
  }
  assert.match(validateAimArgv([]).reason, /must not be empty/);
  assert.match(validateAimArgv(["status", 7]).reason, /strings only/);
  assert.match(validateAimArgv([["status"]]).reason, /strings only/);
});
