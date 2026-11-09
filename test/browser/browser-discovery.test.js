import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discoverSuggestedBrowserBindings } from "../../src/browser/agent-browser.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeChromeLocalState, writeJson } from "../helpers/files.js";

test("discoverSuggestedBrowserBindings prefers exact OpenClaw binding and dedupes identical profile/session candidates", () => {
  const repoRoot = mkTempHome();
  const profileDir = path.join(repoRoot, ".agent-browser", "profiles", "agent-cfo");
  const cfoWorkspace = path.join(repoRoot, "agents", "agent_cfo_bot");
  const duplicateWorkspace = path.join(repoRoot, "agents", "agent_cfo_shadow");
  const officeWorkspace = path.join(repoRoot, "agents", "agent_office");

  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(cfoWorkspace, { recursive: true });
  fs.mkdirSync(duplicateWorkspace, { recursive: true });
  fs.mkdirSync(officeWorkspace, { recursive: true });
  fs.writeFileSync(
    path.join(cfoWorkspace, "agent-browser.json"),
    JSON.stringify({ session: "agent-cfo", profile: profileDir, headed: true }, null, 2),
  );
  fs.writeFileSync(
    path.join(duplicateWorkspace, "agent-browser.json"),
    JSON.stringify({ session: "agent-cfo", profile: profileDir, headed: true }, null, 2),
  );
  fs.writeFileSync(
    path.join(officeWorkspace, "agent-browser.json"),
    JSON.stringify({ session: "agent-office", profile: path.join(repoRoot, ".agent-browser", "profiles", "agent-office"), headed: true }, null, 2),
  );
  fs.mkdirSync(path.join(repoRoot, ".agent-browser", "profiles", "agent-office"), { recursive: true });

  const results = discoverSuggestedBrowserBindings({
    label: "cfo",
    repoRoot,
    bindings: [
      {
        agentId: "agent_cfo_bot",
        match: { channel: "slack", accountId: "cfo" },
      },
    ],
    agentsList: [
      { id: "agent_cfo_bot", name: "CFO Bot", workspace: cfoWorkspace },
      { id: "agent_cfo_shadow", name: "CFO Shadow", workspace: duplicateWorkspace },
      { id: "agent_office", name: "Office", workspace: officeWorkspace },
    ],
  });

  assert.equal(results[0].source, "openclaw-binding");
  assert.equal(results[0].agentId, "agent_cfo_bot");
  assert.equal(
    results.filter(
      (candidate) =>
        candidate.agentBrowserProfile === profileDir && candidate.agentBrowserSession === "agent-cfo",
    ).length,
    1,
  );
});
