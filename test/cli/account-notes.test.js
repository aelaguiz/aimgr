import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot, readAccountNote, writeAccountNote } from "../../src/coordination/redis-store.js";
import { resolveAimgrRedisCachePath } from "../../src/io/paths.js";
import { buildRedisStatusView } from "../../src/status/redis-view.js";
import { renderStatusText } from "../../src/status/render.js";
import { renderStatusCompactText } from "../../src/status/table.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { mkTempHome } from "../helpers/files.js";

import { readNotesForCommand } from "../../src/status/account-notes.js";

test("note reads and edits do not retrieve primary credential records", async () => {
  const { homes: [home], client, store, deps } = await fixture();
  const credentialKeys = new Set([
    store.keys.credential({ provider: "anthropic", label: "iphone_se_1" }),
    store.keys.credential({ provider: "openai-codex", label: "iphone_se_1" }),
  ]);
  const reads = [];
  const original = client.mGet.bind(client);
  client.mGet = async keys => { reads.push(...keys); return original(keys); };
  await runCli(["note", "set", "iphone_se_1", "Local login stays local", "--provider", "anthropic", "--home", home], deps);
  const notes = await readNotesForCommand({ homeDir: home, ...deps });
  assert.equal(notes.find(note => note.provider === "anthropic").note, "Local login stays local");
  assert.deepEqual(reads.filter(key => credentialKeys.has(key)), []);
});

const PREFIX = "aimgr:notes-test";

async function fixture() {
  const homes = [mkTempHome(), mkTempHome()];
  for (const homeDir of homes) writeAimgrConfig({ homeDir, config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } } });
  const client = new FakeRedisClient();
  const connect = () => connectRedisStore({ client, keyPrefix: PREFIX });
  const store = await connect();
  await importCredentialsSnapshot(store, { credentials: [
    { provider: "anthropic", label: "iphone_se_1", credential: {} },
    { provider: "openai-codex", label: "iphone_se_1", credential: {} },
    { provider: "xai", label: "seat", credential: {} },
  ] });
  const deps = { connectRedisStoreImpl: connect, probeUsageSnapshotsByProviderImpl: async () => ({}) };
  return { homes, client, store, deps, connect };
}

test("notes are shared, provider-scoped, editable, and independent of credentials", async () => {
  const { homes: [one, two], store, deps } = await fixture();
  await assert.rejects(runCli(["note", "set", "iphone_se_1", "wrong", "--home", one], deps), /multiple providers.*anthropic.*openai-codex/);
  await assert.rejects(runCli(["note", "show", "missing", "--home", one], deps), /No managed account/);
  const note = "Reserved for Mac Mini 1\nsecond line \u001b[31m\u009b";
  await runCli(["note", "set", "iphone_se_1", note, "--provider", "anthropic", "--home", one], deps);
  const shown = JSON.parse(await runCli(["note", "show", "iphone_se_1", "--provider", "anthropic", "--json", "--home", two], deps));
  assert.equal(shown.note, note);
  const human = await runCli(["note", "show", "iphone_se_1", "--provider", "anthropic", "--home", two], deps);
  assert.doesNotMatch(human, /\u001b/);
  assert.doesNotMatch(human, /\u009b/);
  assert.match(human, /\\nsecond line/);
  assert.equal(JSON.parse(await runCli(["note", "show", "iphone_se_1", "--provider", "openai-codex", "--json", "--home", two], deps)).note, null);

  const before = await readAccountNote(store, { provider: "anthropic", label: "iphone_se_1" });
  await runCli(["note", "set", "iphone_se_1", "Updated", "--provider", "anthropic", "--home", two], deps);
  const stale = await writeAccountNote(store, { provider: "anthropic", label: "iphone_se_1", note: "stale", expectedVersion: before.version });
  assert.equal(stale.code, "stale_version");
  assert.equal((await readAccountNote(store, { provider: "anthropic", label: "iphone_se_1" })).note, "Updated");
  await runCli(["note", "clear", "iphone_se_1", "--provider", "anthropic", "--home", one], deps);
  assert.equal(JSON.parse(await runCli(["note", "show", "iphone_se_1", "--provider", "anthropic", "--json", "--home", two], deps)).note, null);
  await runCli(["note", "set", "iphone_se_1", "Again", "--provider", "anthropic", "--home", two], deps);
  assert.equal((await readAccountNote(store, { provider: "anthropic", label: "iphone_se_1" })).note, "Again");
});

test("status shows notes for blocked and other-provider accounts without writing them to local cache", async () => {
  const { homes: [home], deps, connect } = await fixture();
  const text = "For Mac Mini 1, unique note";
  await runCli(["note", "set", "iphone_se_1", text, "--provider", "anthropic", "--home", home], deps);
  await runCli(["note", "set", "seat", "Shared Grok account", "--home", home], deps);
  const live = await buildRedisStatusView({ homeDir: home, connectRedisStoreImpl: connect, probeUsageSnapshotsByProviderImpl: async () => ({}) });
  assert.equal(live.view.redis.status, "live");
  assert.match(renderStatusText(live.view, { claudeUsageStatus: live.claudeUsageStatus }), /anthropic \/ iphone_se_1: "For Mac Mini 1, unique note"/);
  assert.match(renderStatusCompactText(live.view), /xai \/ seat: "Shared Grok account"/);
  assert.equal(live.view.accountNotes.length, 2);
  assert.doesNotMatch(fs.readFileSync(resolveAimgrRedisCachePath({ homeDir: home }), "utf8"), /unique note|Shared Grok account/);
  const offline = await buildRedisStatusView({ homeDir: home, connectRedisStoreImpl: async () => { throw new Error("offline"); } });
  assert.equal(offline.view.accountNotes, null);
  assert.match(renderStatusText(offline.view), /ACCOUNT NOTES\nUnavailable/);
  assert.match(renderStatusCompactText(offline.view), /account notes unavailable/);
  await assert.rejects(runCli(["note", "show", "seat", "--home", home], { connectRedisStoreImpl: async () => { throw new Error("offline"); } }), /offline/);
});

test("provider status exposes the shared note in text and JSON", async () => {
  const { homes: [home], deps } = await fixture();
  await runCli(["note", "set", "iphone_se_1", "Mini only", "--provider", "anthropic", "--home", home], deps);
  await runCli(["note", "set", "seat", "Grok note", "--home", home], deps);
  const claude = JSON.parse(await runCli(["claude", "inventory", "--json", "--home", home], deps));
  assert.equal(claude.accounts.find((account) => account.label === "iphone_se_1").note, "Mini only");
  const grok = JSON.parse(await runCli(["grok", "inventory", "--json", "--home", home], deps));
  assert.equal(grok.rows[0].note, "Grok note");
  assert.match(await runCli(["grok", "inventory", "--home", home], deps), /Grok note/);
});
