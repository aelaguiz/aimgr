import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  IDENTITY_STATE_TYPE,
  firstUserPrompt,
  latestAgentRecap,
  pickSessionColor,
  readIdentityState,
  renderIdentityLine,
  renderSessionIdLine,
  titleFromPrompt,
  titleFromRecap,
} from "../../native/harness/session-title-footer.js";
import {
  ensureHarnessSessionIdentityExtension,
  isLegacyHarnessSessionIdentityExtension,
} from "../../src/targets/harness-session-identity.js";
import { mkTempHome } from "../helpers/files.js";

const requestedPrompt =
  "Can we just make our title always show that little status bar plugin we added so I don't have to type /rename to see it?";

test("automatic title helpers produce bounded useful names from prompts and Prime recaps", () => {
  assert.equal(
    titleFromPrompt(requestedPrompt),
    "Make our title always show that little status bar plugin",
  );
  assert.equal(
    titleFromRecap("Implementing persistent colored agent identity banners."),
    "Implementing persistent colored agent identity banners",
  );
  assert.equal(titleFromPrompt("/goal   Refactor the auth projection without compatibility shims"),
    "Refactor the auth projection without compatibility shims");
  assert.ok(titleFromPrompt("word ".repeat(30)).length <= 68);
});

test("identity state, prompt, recap, and ANSI banner helpers preserve the session color", () => {
  const entries = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: requestedPrompt }] } },
    {
      type: "custom",
      customType: IDENTITY_STATE_TYPE,
      data: { version: 1, color: "green", autoTitle: "Automatic title", titleSource: "prompt" },
    },
    {
      type: "agent_status",
      status: { summary: "Shipping durable session identity", basedOnMessageCount: 4 },
    },
  ];

  assert.equal(firstUserPrompt(entries), requestedPrompt);
  assert.deepEqual(latestAgentRecap(entries), {
    summary: "Shipping durable session identity",
    basedOnMessageCount: 4,
  });
  assert.deepEqual(readIdentityState(entries), {
    version: 1,
    color: "green",
    autoTitle: "Automatic title",
    titleSource: "prompt",
  });
  assert.equal(pickSessionColor(() => 0.35), "green");
  assert.match(
    renderIdentityLine({
      title: "Automatic title",
      color: "green",
      account: "qa",
      branch: "main",
      cwd: "~/workspace/aimgr",
    }),
    /^\u001b\[1;97;48;5;28m title:Automatic title /,
  );
});

test("session identity rendering preserves the full canonical UUID without suffix collisions", () => {
  const first = "019fd96e-51cb-72ef-ae34-83ecf10c6a12";
  const second = "11111111-2222-3333-4444-5555550c6a12";

  assert.equal(renderSessionIdLine(first), `\u001b[2m session-id: ${first}\u001b[0m`);
  assert.equal(renderSessionIdLine(`${first}\n`), `\u001b[2m session-id: ${first}\u001b[0m`);
  assert.notEqual(renderSessionIdLine(first), renderSessionIdLine(second));
  assert.equal(renderSessionIdLine(undefined), undefined);
});

function createExtensionHarness(initialEntries = [], initialName = "", options = {}) {
  const handlers = new Map();
  const entries = [...initialEntries];
  const widgets = [];
  const terminalTitles = [];
  const setNames = [];
  let sessionName = initialName;
  let setNameAttempts = 0;
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    async setSessionName(name) {
      setNameAttempts += 1;
      if (setNameAttempts <= (options.rejectFirstNameAttempts ?? 0)) {
        throw new Error("duplicate session name");
      }
      sessionName = name;
      setNames.push(name);
      entries.push({ type: "session_info", name });
    },
    getSessionName() {
      return sessionName || undefined;
    },
  };
  const ctx = {
    cwd: mkTempHome(),
    model: { provider: "openai-codex" },
    sessionManager: {
      getEntries: () => entries,
      getSessionName: () => sessionName || undefined,
      getSessionId: () => options.sessionId ?? "019fd96e-51cb-72ef-ae34-83ecf10c6a12",
      getCredentialBindings: () => new Map([
        ["openai-codex", { binding: "qa" }],
      ]),
    },
    ui: {
      setWidget(key, content, options) {
        widgets.push({ key, content, options });
      },
      setTitle(title) {
        terminalTitles.push(title);
      },
    },
  };
  return {
    pi,
    ctx,
    handlers,
    entries,
    widgets,
    terminalTitles,
    setNames,
    getName: () => sessionName,
    getSetNameAttempts: () => setNameAttempts,
    setName: (name) => {
      sessionName = name;
      entries.push({ type: "session_info", name });
    },
  };
}

test("extension names the first request, upgrades once from a native recap, and respects manual rename", async () => {
  const harness = createExtensionHarness();
  const { default: loadExtension } = await import("../../native/harness/session-title-footer.js");
  loadExtension(harness.pi);

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  assert.equal(readIdentityState(harness.entries), undefined);
  const initialWidget = harness.widgets.at(-1).content[0];
  assert.match(initialWidget, /title:waiting for first prompt/);
  assert.match(initialWidget, /account:qa/);
  assert.deepEqual(harness.widgets.at(-1).content, [
    initialWidget,
    "\u001b[2m session-id: 019fd96e-51cb-72ef-ae34-83ecf10c6a12\u001b[0m",
  ]);

  await harness.handlers.get("input")({ text: requestedPrompt, source: "interactive" }, harness.ctx);
  assert.equal(harness.getName(), "Make our title always show that little status bar plugin");
  const promptState = readIdentityState(harness.entries);
  assert.equal(promptState.titleSource, "prompt");
  assert.match(harness.terminalTitles.at(-1), /^Make our title always show/);

  harness.entries.push({
    type: "agent_status",
    status: { summary: "Adding persistent colored session identity", basedOnMessageCount: 2 },
  });
  await harness.handlers.get("agent_end")({ type: "agent_end" }, harness.ctx);
  assert.equal(harness.getName(), "Adding persistent colored session identity");
  assert.deepEqual(readIdentityState(harness.entries), {
    version: 1,
    color: promptState.color,
    autoTitle: "Adding persistent colored session identity",
    titleSource: "recap",
    recapMessageCount: 2,
  });

  harness.setName("Green work");
  harness.entries.push({
    type: "agent_status",
    status: { summary: "A later status must not replace manual work", basedOnMessageCount: 4 },
  });
  await harness.handlers.get("agent_end")({ type: "agent_end" }, harness.ctx);
  assert.equal(harness.getName(), "Green work");
  assert.deepEqual(harness.setNames, [
    "Make our title always show that little status bar plugin",
    "Adding persistent colored session identity",
  ]);

  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
  assert.deepEqual(harness.widgets.at(-1), {
    key: "session-identity",
    content: undefined,
    options: { placement: "belowEditor" },
  });
});

test("automatic naming adds a stable session suffix when Prime rejects a duplicate root name", async () => {
  const harness = createExtensionHarness([], "", {
    rejectFirstNameAttempts: 1,
    sessionId: "019fd96e-51cb-72ef-ae34-83ecf10c6a12",
  });
  const { default: loadExtension } = await import("../../native/harness/session-title-footer.js");
  loadExtension(harness.pi);

  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  await harness.handlers.get("input")({ text: requestedPrompt, source: "interactive" }, harness.ctx);

  assert.equal(harness.getSetNameAttempts(), 2);
  assert.match(harness.getName(), / · 0c6a12$/);
  assert.ok(harness.getName().length <= 68);
  assert.equal(readIdentityState(harness.entries).autoTitle, harness.getName());
  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("a same-text human rename remains authoritative over a later recap", async () => {
  const harness = createExtensionHarness();
  const { default: loadExtension } = await import("../../native/harness/session-title-footer.js");
  loadExtension(harness.pi);

  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  await harness.handlers.get("input")({ text: requestedPrompt, source: "interactive" }, harness.ctx);
  const automaticTitle = harness.getName();
  await harness.pi.setSessionName(automaticTitle);
  harness.entries.push({
    type: "agent_status",
    status: { summary: "A different recap must not win", basedOnMessageCount: 9 },
  });
  await harness.handlers.get("agent_end")({ type: "agent_end" }, harness.ctx);

  assert.equal(harness.getName(), automaticTitle);
  assert.equal(readIdentityState(harness.entries).titleSource, "prompt");
  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("the refresh cadence re-broadcasts unchanged daemon UI for late attachments", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let refresh;
  globalThis.setInterval = (callback) => {
    refresh = callback;
    return { unref() {} };
  };
  globalThis.clearInterval = () => {};
  try {
    const harness = createExtensionHarness();
    const { default: loadExtension } = await import("../../native/harness/session-title-footer.js");
    loadExtension(harness.pi);
    await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
    assert.equal(readIdentityState(harness.entries), undefined);
    const widgetCount = harness.widgets.length;
    const titleCount = harness.terminalTitles.length;

    refresh();
    assert.equal(harness.widgets.length, widgetCount + 1);
    assert.equal(harness.terminalTitles.length, titleCount + 1);
    assert.equal(readIdentityState(harness.entries), undefined);
    assert.deepEqual(harness.widgets.at(-1).content, harness.widgets.at(-2).content);
    assert.match(harness.widgets.at(-1).content[1], /session-id: 019fd96e-51cb-72ef-ae34-83ecf10c6a12/);

    await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("the identity banner follows the session binding after a live credential handoff", async () => {
  const harness = createExtensionHarness([
    {
      type: "custom",
      customType: "aimgr_credential_binding_v1",
      data: { provider: "openai-codex", source: "aimgr", binding: "qa" },
    },
    {
      type: "custom",
      customType: "aimgr_credential_binding_v1",
      data: { provider: "openai-codex", source: "aimgr", binding: "growth" },
    },
  ]);
  delete harness.ctx.sessionManager.getCredentialBindings;
  const { default: loadExtension } = await import("../../native/harness/session-title-footer.js");
  loadExtension(harness.pi);

  await harness.handlers.get("session_start")({ type: "session_start", reason: "resume" }, harness.ctx);
  assert.match(harness.widgets.at(-1).content[0], /account:growth/);

  harness.entries.push({
    type: "custom",
    customType: "aimgr_credential_binding_v1",
    data: { provider: "openai-codex", source: "aimgr", binding: "pro11" },
  });
  await harness.handlers.get("agent_start")({ type: "agent_start" }, harness.ctx);
  assert.match(harness.widgets.at(-1).content[0], /account:pro11/);

  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("an explicit name command remains human-owned from the first input", async () => {
  const harness = createExtensionHarness();
  const { default: loadExtension } = await import("../../native/harness/session-title-footer.js");
  loadExtension(harness.pi);

  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  await harness.handlers.get("input")(
    { type: "input", text: "/rename My deliberate name", source: "interactive" },
    harness.ctx,
  );
  assert.equal(harness.getName(), "");

  await harness.pi.setSessionName("My deliberate name");
  await harness.handlers.get("agent_start")({ type: "agent_start" }, harness.ctx);
  harness.entries.push({
    type: "agent_status",
    status: { summary: "A recap that must not replace the deliberate title", basedOnMessageCount: 2 },
  });
  await harness.handlers.get("agent_end")({ type: "agent_end" }, harness.ctx);
  assert.equal(harness.getName(), "My deliberate name");
  assert.equal(readIdentityState(harness.entries).autoTitle, undefined);

  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("extension restores an existing automatic name and exact color on resume", async () => {
  const state = {
    version: 1,
    color: "purple",
    autoTitle: "Persisted purple work",
    titleSource: "recap",
    recapMessageCount: 6,
  };
  const harness = createExtensionHarness([
    { type: "custom", customType: IDENTITY_STATE_TYPE, data: state },
  ]);
  const { default: loadExtension } = await import("../../native/harness/session-title-footer.js");
  loadExtension(harness.pi);

  await harness.handlers.get("session_start")({ type: "session_start", reason: "resume" }, harness.ctx);
  assert.equal(harness.getName(), "Persisted purple work");
  assert.match(harness.widgets.at(-1).content[0], /^\u001b\[1;97;48;5;55m title:Persisted purple work /);
  assert.equal(
    harness.widgets.at(-1).content[1],
    "\u001b[2m session-id: 019fd96e-51cb-72ef-ae34-83ecf10c6a12\u001b[0m",
  );
  assert.equal(readIdentityState(harness.entries).color, "purple");

  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("managed extension projection is atomic, idempotent, adopts the legacy footer, and refuses conflicts", () => {
  const home = mkTempHome();
  const agentDir = path.join(home, ".prime", "agent");
  const extensionPath = path.join(agentDir, "extensions", "session-title-footer.ts");

  const installed = ensureHarnessSessionIdentityExtension({ agentDir });
  assert.deepEqual(installed, { status: "installed", path: extensionPath });
  const installedSource = fs.readFileSync(extensionPath, "utf8");
  assert.match(installedSource, /^\/\/ Managed by aimgr\./);
  assert.match(installedSource, /session-id:/);
  assert.equal(
    installedSource,
    fs.readFileSync(new URL("../../native/harness/session-title-footer.js", import.meta.url), "utf8"),
  );
  assert.equal(fs.statSync(extensionPath).mode & 0o777, 0o644);
  assert.deepEqual(ensureHarnessSessionIdentityExtension({ agentDir }), {
    status: "unchanged",
    path: extensionPath,
  });

  const legacyPiFooter = fs.readFileSync(
    new URL("./fixtures/session-title-footer-pi-legacy.ts", import.meta.url),
    "utf8",
  );
  const legacyPrimeWidget = fs.readFileSync(
    new URL("./fixtures/session-title-footer-prime-legacy.ts", import.meta.url),
    "utf8",
  );
  assert.equal(isLegacyHarnessSessionIdentityExtension(legacyPiFooter), true);
  assert.equal(isLegacyHarnessSessionIdentityExtension(legacyPrimeWidget), true);
  assert.equal(
    isLegacyHarnessSessionIdentityExtension(`${legacyPiFooter}
// personal edit`),
    false,
  );
  fs.writeFileSync(extensionPath, legacyPiFooter);
  assert.equal(ensureHarnessSessionIdentityExtension({ agentDir }).status, "updated");

  fs.writeFileSync(extensionPath, "export default function personalExtension() {}\n");
  assert.throws(
    () => ensureHarnessSessionIdentityExtension({ agentDir }),
    /Refusing to overwrite unmanaged session identity extension/,
  );
  assert.equal(fs.readFileSync(extensionPath, "utf8"), "export default function personalExtension() {}\n");
});
