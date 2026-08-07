import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  drainCodexDesktopIdentityCopies,
  scanCodexDesktopIdentityCopies,
} from "../../src/targets/codex-desktop-drain.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

const DESKTOP_ACCOUNT_ID = "acct_desktop";
const OTHER_ACCOUNT_ID = "acct_other";

function codexJwt(accountId) {
  return makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

function openclawStorePath(home, agentId) {
  return path.join(home, ".openclaw", "agents", agentId, "agent", "auth-profiles.json");
}

function snapshotTree(rootDir) {
  const entries = new Map();
  if (!fs.existsSync(rootDir)) return entries;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.set(full, fs.readFileSync(full, "utf8"));
    }
  };
  walk(rootDir);
  return entries;
}

function seedDrainFixture() {
  const home = mkTempHome();
  const matchingJwt = codexJwt(DESKTOP_ACCOUNT_ID);
  const otherJwt = codexJwt(OTHER_ACCOUNT_ID);

  // Active OpenClaw stores: matching + unrelated codex + unrelated anthropic.
  writeJson(openclawStorePath(home, "main"), {
    version: 1,
    profiles: {
      "openai-codex:desktop": {
        type: "oauth", provider: "openai-codex", access: matchingJwt,
        refresh: "REFRESH_DESKTOP", accountId: DESKTOP_ACCOUNT_ID, expires: 1,
      },
      "openai-codex:worker": {
        type: "oauth", provider: "openai-codex", access: otherJwt,
        refresh: "REFRESH_WORKER", accountId: OTHER_ACCOUNT_ID, expires: 1,
      },
      "anthropic:keep": { type: "oauth", provider: "anthropic", access: "A", refresh: "R", expires: 1 },
    },
    order: { "openai-codex": ["openai-codex:desktop", "openai-codex:worker"] },
    lastGood: { "openai-codex": "openai-codex:desktop" },
  });
  // Matching entry without an explicit accountId (token-derived identity only).
  writeJson(openclawStorePath(home, "agent_x"), {
    version: 1,
    profiles: {
      "openai-codex:alias": {
        type: "oauth", provider: "openai-codex", access: matchingJwt,
        refresh: "REFRESH_ALIAS", expires: 1,
      },
    },
  });
  // Untouched store with no matching identity.
  writeJson(openclawStorePath(home, "agent_clean"), {
    version: 1,
    profiles: {
      "openai-codex:worker": {
        type: "oauth", provider: "openai-codex", access: otherJwt,
        refresh: "REFRESH_WORKER", accountId: OTHER_ACCOUNT_ID, expires: 1,
      },
    },
  });
  // AIM-created timestamped backup of the main store with a matching entry.
  writeJson(`${openclawStorePath(home, "main")}.bak.2026-01-02T03-04-05`, {
    version: 1,
    profiles: {
      "openai-codex:desktop": {
        type: "oauth", provider: "openai-codex", access: matchingJwt,
        refresh: "OLD_REFRESH_DESKTOP", accountId: DESKTOP_ACCOUNT_ID, expires: 1,
      },
      "anthropic:keep": { type: "oauth", provider: "anthropic", access: "A", refresh: "R", expires: 1 },
    },
  });

  // Hermes homes: one with matching tokens + pool entry, one unrelated.
  writeJson(path.join(home, ".hermes", "profiles", "home1", "auth.json"), {
    version: 3,
    active_provider: "openai-codex",
    providers: {
      "openai-codex": {
        tokens: { access_token: matchingJwt, refresh_token: "HERMES_REFRESH" },
        auth_mode: "chatgpt",
      },
    },
    credential_pool: {
      "openai-codex": [
        { id: "aaa", source: "device_code", access_token: matchingJwt, refresh_token: "HERMES_REFRESH" },
        { id: "bbb", source: "device_code", access_token: otherJwt, refresh_token: "OTHER_REFRESH" },
      ],
    },
  });
  writeJson(path.join(home, ".hermes", "profiles", "home2", "auth.json"), {
    version: 3,
    active_provider: "openai-codex",
    providers: {
      "openai-codex": {
        tokens: { access_token: otherJwt, refresh_token: "OTHER_REFRESH" },
      },
    },
  });

  // Displaced harness backups: pi matches, prime does not.
  writeJson(path.join(home, ".aimgr", "backups", "harness-auth", "pi-openai-codex.json"), {
    schemaVersion: 1,
    target: "pi",
    provider: "openai-codex",
    entry: { type: "oauth", access: matchingJwt, refresh: "PI_REFRESH", accountId: DESKTOP_ACCOUNT_ID, expires: 2 },
  });
  writeJson(path.join(home, ".aimgr", "backups", "harness-auth", "prime-openai-codex.json"), {
    schemaVersion: 1,
    target: "prime",
    provider: "openai-codex",
    entry: { type: "oauth", access: otherJwt, refresh: "PRIME_REFRESH", accountId: OTHER_ACCOUNT_ID, expires: 2 },
  });
  return { home, matchingJwt, otherJwt };
}

function assertExpectedCounts(receipt, { dryRun }) {
  assert.equal(receipt.dryRun, dryRun);
  assert.equal(receipt.matched, true);
  assert.equal(receipt.openclaw.storesScanned, 3);
  assert.equal(receipt.openclaw.storesWithMatches, 2);
  assert.equal(receipt.openclaw.entriesRemoved, 2);
  assert.equal(receipt.openclaw.backupsScanned, 1);
  assert.equal(receipt.openclaw.backupsWithMatches, 1);
  assert.equal(receipt.openclaw.backupEntriesRemoved, 1);
  assert.equal(receipt.hermes.homesScanned, 2);
  assert.equal(receipt.hermes.homesWithMatches, 1);
  assert.equal(receipt.hermes.tokenSetsRemoved, 1);
  assert.equal(receipt.hermes.poolEntriesRemoved, 1);
  assert.equal(receipt.harnessBackups.scanned, 2);
  assert.equal(receipt.harnessBackups.matched, 1);
  assert.equal(receipt.harnessBackups.removed, dryRun ? 1 : 1);
}

test("dryRun scan reports exact counts and writes nothing", () => {
  const { home } = seedDrainFixture();
  const before = snapshotTree(home);
  const receipt = scanCodexDesktopIdentityCopies({ homeDir: home, accountId: DESKTOP_ACCOUNT_ID });
  assertExpectedCounts(receipt, { dryRun: true });
  assert.deepEqual(snapshotTree(home), before);
});

test("drain removes exactly the matching identity, preserves the rest, and creates no new secret backup", () => {
  const { home, matchingJwt } = seedDrainFixture();
  const before = snapshotTree(home);
  const receipt = drainCodexDesktopIdentityCopies({ homeDir: home, accountId: DESKTOP_ACCOUNT_ID });
  assertExpectedCounts(receipt, { dryRun: false });
  assert.equal(receipt.wrote, true);

  const after = snapshotTree(home);
  // No new files appeared anywhere (especially no fresh .bak copies).
  for (const filePath of after.keys()) {
    assert.ok(before.has(filePath), `unexpected new file: ${filePath}`);
  }
  // The pi displaced backup is gone; the prime one is untouched.
  assert.equal(after.has(path.join(home, ".aimgr", "backups", "harness-auth", "pi-openai-codex.json")), false);
  assert.equal(
    after.get(path.join(home, ".aimgr", "backups", "harness-auth", "prime-openai-codex.json")),
    before.get(path.join(home, ".aimgr", "backups", "harness-auth", "prime-openai-codex.json")),
  );

  const main = JSON.parse(after.get(openclawStorePath(home, "main")));
  assert.deepEqual(Object.keys(main.profiles).toSorted(), ["anthropic:keep", "openai-codex:worker"]);
  assert.deepEqual(main.order["openai-codex"], ["openai-codex:worker"]);
  assert.equal("openai-codex" in main.lastGood, false);

  const agentX = JSON.parse(after.get(openclawStorePath(home, "agent_x")));
  assert.deepEqual(agentX.profiles, {});

  // Untouched files stay byte-identical.
  assert.equal(after.get(openclawStorePath(home, "agent_clean")), before.get(openclawStorePath(home, "agent_clean")));
  assert.equal(
    after.get(path.join(home, ".hermes", "profiles", "home2", "auth.json")),
    before.get(path.join(home, ".hermes", "profiles", "home2", "auth.json")),
  );

  const storeBackup = JSON.parse(after.get(`${openclawStorePath(home, "main")}.bak.2026-01-02T03-04-05`));
  assert.deepEqual(Object.keys(storeBackup.profiles), ["anthropic:keep"]);

  const hermes1 = JSON.parse(after.get(path.join(home, ".hermes", "profiles", "home1", "auth.json")));
  assert.equal("openai-codex" in hermes1.providers, false);
  assert.equal("active_provider" in hermes1, false);
  assert.equal(hermes1.credential_pool["openai-codex"].length, 1);
  assert.equal(hermes1.credential_pool["openai-codex"][0].id, "bbb");

  // No matching raw material remains anywhere under the home.
  for (const content of after.values()) {
    assert.doesNotMatch(content, /REFRESH_DESKTOP|REFRESH_ALIAS|HERMES_REFRESH|PI_REFRESH|OLD_REFRESH_DESKTOP/);
    assert.equal(content.includes(matchingJwt), false);
  }

  // The receipt itself carries no secrets, labels, paths, or account IDs:
  // only fixed kind names, counts, and booleans.
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /acct_|REFRESH|\//);
  assert.equal(serialized.includes(matchingJwt), false);
  assert.equal(serialized.includes(home), false);

  // A second drain is a clean no-op.
  const again = drainCodexDesktopIdentityCopies({ homeDir: home, accountId: DESKTOP_ACCOUNT_ID });
  assert.equal(again.matched, false);
  assert.equal(again.wrote, false);
});

test("drain resolves the identity from label plus raw records, including credential-empty ones", () => {
  const { home } = seedDrainFixture();
  const records = [
    {
      provider: "openai-codex",
      label: "desktop",
      credential: {},
      identity: { accountId: DESKTOP_ACCOUNT_ID },
    },
  ];
  const receipt = drainCodexDesktopIdentityCopies({
    homeDir: home,
    label: "desktop",
    records,
    dryRun: true,
  });
  assertExpectedCounts(receipt, { dryRun: true });

  assert.throws(
    () => drainCodexDesktopIdentityCopies({ homeDir: home, label: "missing", records }),
    /Cannot resolve an immutable Codex account identity/,
  );
});

test("drain leaves homes without matching material untouched and reports no match", () => {
  const home = mkTempHome();
  writeJson(openclawStorePath(home, "main"), {
    version: 1,
    profiles: {
      "openai-codex:worker": {
        type: "oauth", provider: "openai-codex", access: codexJwt(OTHER_ACCOUNT_ID),
        refresh: "REFRESH_WORKER", accountId: OTHER_ACCOUNT_ID, expires: 1,
      },
    },
  });
  const before = snapshotTree(home);
  const receipt = drainCodexDesktopIdentityCopies({ homeDir: home, accountId: DESKTOP_ACCOUNT_ID });
  assert.equal(receipt.matched, false);
  assert.equal(receipt.wrote, false);
  assert.deepEqual(snapshotTree(home), before);
});
