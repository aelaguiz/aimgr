import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexModel, resolveCodexModelArgs } from "../../src/core/codex-models.js";

function homeWithCatalog(models) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aim-codex-models-"));
  if (models) {
    fs.mkdirSync(path.join(homeDir, ".codex"));
    fs.writeFileSync(path.join(homeDir, ".codex", "models_cache.json"), JSON.stringify({ models }));
  }
  return homeDir;
}

const listed = slug => ({ slug, visibility: "list" });

test("a family name picks the newest listed version from Codex's catalog", () => {
  const homeDir = homeWithCatalog([listed("gpt-6-astra"), listed("gpt-6.2-astra"), listed("gpt-6.1-sol"),
    listed("gpt-6-sol"), listed("gpt-5.6-sol"), { slug: "gpt-6.3-sol", visibility: "hide" }, listed("gpt-6.10-terra"), listed("gpt-6.9-terra")]);
  assert.equal(resolveCodexModel("astra", { homeDir }), "gpt-6.2-astra");
  assert.equal(resolveCodexModel("Sol", { homeDir }), "gpt-6.2-sol");
  assert.equal(resolveCodexModel("terra", { homeDir }), "gpt-6.10-terra");
  assert.equal(resolveCodexModel("gpt-6-astra", { homeDir }), "gpt-6-astra");
});

test("an older catalog never picks a version below the known newest", () => {
  const homeDir = homeWithCatalog([listed("gpt-6.1-sol"), listed("gpt-6-astra"), listed("gpt-6.3-sol")]);
  assert.equal(resolveCodexModel("sol", { homeDir }), "gpt-6.3-sol");
  assert.equal(resolveCodexModel("astra", { homeDir }), "gpt-6.2-astra");
});

test("a missing catalog falls back to the newest known version", () => {
  const homeDir = homeWithCatalog(null);
  assert.equal(resolveCodexModel("astra", { homeDir }), "gpt-6.2-astra");
  assert.equal(resolveCodexModel("sol", { homeDir }), "gpt-6.2-sol");
});

test("Codex model flags accept family names", () => {
  const homeDir = homeWithCatalog([listed("gpt-6.2-astra"), listed("gpt-6.1-sol")]);
  assert.deepEqual(resolveCodexModelArgs(["exec", "-m", "sol", "--model=astra", "--model", "gpt-6-astra", "astra"], { homeDir }),
    ["exec", "-m", "gpt-6.2-sol", "--model=gpt-6.2-astra", "--model", "gpt-6-astra", "astra"]);
});
