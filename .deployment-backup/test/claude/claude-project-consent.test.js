import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inheritClaudeProjectConsent } from "../../src/targets/claude-project-consent.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

function accountConfig(home, label) {
  return path.join(home, ".aimgr", "claude-homes", label, ".claude");
}

test("managed Claude reuses only positive consent for the current project", () => {
  const home = mkTempHome();
  const cwd = path.join(home, "work");
  const unrelated = path.join(home, "other");
  const source = accountConfig(home, "source");
  const selected = accountConfig(home, "selected");
  fs.mkdirSync(cwd);
  writeJson(path.join(home, ".claude.json"), {
    oauthAccount: { accountUuid: "normal-account-must-not-copy" },
    projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: ["normal-tool-must-not-copy"] } },
  });
  writeJson(path.join(source, ".claude.json"), {
    oauthAccount: { accountUuid: "source-account-must-not-copy" },
    projects: {
      [cwd]: {
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
        lastSessionId: "source-session-must-not-copy",
      },
      [unrelated]: { hasTrustDialogAccepted: true },
    },
  });
  writeJson(path.join(selected, ".claude.json"), {
    oauthAccount: { accountUuid: "selected-account" },
    projects: { [cwd]: { hasTrustDialogAccepted: false, existing: "keep" } },
  });

  const result = inheritClaudeProjectConsent({ userHomeDir: home, configDir: selected, cwd });
  assert.deepEqual(result, { wrote: true, trusted: true, externalImportsApproved: true });
  const target = JSON.parse(fs.readFileSync(path.join(selected, ".claude.json"), "utf8"));
  assert.deepEqual(target.projects[cwd], {
    hasTrustDialogAccepted: true,
    existing: "keep",
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true,
  });
  assert.equal(target.oauthAccount.accountUuid, "selected-account");
  assert.equal(target.projects[unrelated], undefined);
  assert.doesNotMatch(JSON.stringify(target), /must-not-copy/);
  assert.deepEqual(inheritClaudeProjectConsent({ userHomeDir: home, configDir: selected, cwd }), {
    wrote: false, trusted: true, externalImportsApproved: true,
  });
});

test("managed Claude leaves a new project unapproved until the user accepts it", () => {
  const home = mkTempHome();
  const cwd = path.join(home, "new-work");
  const selected = accountConfig(home, "selected");
  fs.mkdirSync(cwd);
  writeJson(path.join(home, ".claude.json"), {
    projects: { [cwd]: { hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false } },
  });
  writeJson(path.join(selected, ".claude.json"), {
    oauthAccount: { accountUuid: "selected-account" },
    projects: { [cwd]: { hasTrustDialogAccepted: false } },
  });
  const targetPath = path.join(selected, ".claude.json");
  const before = fs.readFileSync(targetPath, "utf8");
  assert.deepEqual(inheritClaudeProjectConsent({ userHomeDir: home, configDir: selected, cwd }), {
    wrote: false, trusted: false, externalImportsApproved: false,
  });
  assert.equal(fs.readFileSync(targetPath, "utf8"), before);
});
