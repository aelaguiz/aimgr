import test from "node:test";
import assert from "node:assert/strict";
import { assertNoCodexConsumers, assertNativeMcpRead } from "../../src/credentials/codex-mcp-maintenance-owner.js";

const row = (pid, image, args = [], parent = 1) => ({ pid, parent, image, args, birth: String(pid) });
test("conversion refuses live affected clients and updaters without controlling their processes", () => {
  for (const owner of [row(11, "/opt/codex", ["codex", "exec", "task"]),
    row(12, "/opt/codex", ["codex", "app-server", "daemon", "pid-update-loop"]),
    row(13, "/opt/node", ["node", "/repo/aimgr/bin/aimgr.js", "codex", "run"]),
    row(14, "/opt/node", ["node", "/repo/aimgr/bin/aimgr.js", "routine", "__execute", "codex-review"]),
    row(16, "/opt/old/codex (deleted)")]) {
    assert.throws(() => assertNoCodexConsumers([owner], 99, ["codex-review"]), /finish or exit normally/);
  }
});
test("conversion requires a terminal outside a live Codex owner", () => {
  assert.throws(() => assertNoCodexConsumers([row(10, "/opt/codex"), row(11, "/bin/zsh", [], 10),
    row(12, "/opt/node", [], 11)], 12), /terminal outside/);
});
test("unrelated scripts, IDEs and other providers do not veto credential conversion", () => {
  assert.doesNotThrow(() => assertNoCodexConsumers([
    row(10, "/bin/sh", ["sh", "-s"]), row(11, "/Applications/Editor.app/Contents/MacOS/Editor"),
    row(12, "/opt/claude"), row(13, "/opt/prime-agent"),
    row(14, "/opt/node", ["node", "/repo/aimgr/bin/aimgr.js", "routine", "run", "claude-review"]),
    row(15, "/bin/sh", ["sh", "-c", "while :; do codex; sleep 30; done"]),
  ], 99, ["codex-review"]));
});
test("the maintenance invocation's AIM ancestors do not veto their own operation", () => {
  assert.doesNotThrow(() => assertNoCodexConsumers([
    row(10, "/opt/node", ["node", "/repo/aimgr/bin/aimgr.js", "codex", "mcp-migrate"]),
    row(15, "/bin/sh", ["sh", "-s"]),
    row(11, "/usr/bin/python3", [], 10), row(12, "/opt/node", [], 11),
  ], 12));
});


test("conversion verifies imported identities while preserving unrelated managed MCP servers", () => {
  const items = [{ serverName: "calendar", url: "https://calendar.invalid/mcp" }];
  const entry = { name: "calendar", transport: { type: "streamable_http", url: items[0].url }, auth_status: "o_auth" };
  assert.doesNotThrow(() => assertNativeMcpRead([entry], items));
  assert.doesNotThrow(() => assertNativeMcpRead([entry, { name: "managed-extra", transport: { type: "stdio" }, auth_status: "unsupported" }], items));
  assert.doesNotThrow(() => assertNativeMcpRead([], []));
  assert.doesNotThrow(() => assertNativeMcpRead([{ ...entry, auth_status: "not_logged_in" }], items));
  for (const entries of [undefined, [], [entry, entry], [{ ...entry, auth_status: "unknown" }],
    [{ ...entry, name: "different" }], [{ ...entry, transport: { type: "streamable_http", url: "https://different.invalid/" } }],
    [{ ...entry, transport: { type: "stdio" } }]]) {
    assert.throws(() => assertNativeMcpRead(entries, items), /original File credentials remain preserved/);
  }
});
