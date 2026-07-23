import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../helpers/cli-runner.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PUBLIC_COMMAND_STEMS = [
  "aim status",
  "aim redis configure",
  "aim redis config",
  "aim redis migrate collect",
  "aim redis migrate plan",
  "aim redis migrate apply",
  "aim redis migrate cleanup-legacy",
  "aim label rebind",
  "aim <label>",
  "aim login <label>",
  "aim login <label> --manual-callback-stdio",
  "aim rebalance openclaw",
  "aim rebalance hermes",
  "aim auth write hermes",
  "aim codex use",
  "aim codex watch",
  "aim codex run",
  "aim hermes watch",
  "aim claude status",
  "aim claude usage",
  "aim claude inventory",
  "aim claude run",
  "aim claude capture-native",
  "aim claude export-live",
  "aim claude import-native",
  "aim pi use",
  "aim sakana add",
  "aim sakana use",
  "aim sakana list",
  "aim sakana show",
  "aim sakana remove",
  "aim browser show",
  "aim browser set",
];

function readRepoText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function commandPattern(command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(escaped);
}

test("README command surface stays in parity with CLI help", async () => {
  const readme = readRepoText("README.md");
  const help = await runCli(["--help"]);

  // README and --help are the two operator-facing command maps. A command can
  // be intentionally advanced, but it should not exist in only one surface.
  for (const command of PUBLIC_COMMAND_STEMS) {
    assert.match(help, commandPattern(command), `help is missing ${command}`);
    assert.match(readme, commandPattern(command), `README is missing ${command}`);
  }
});

test("README development proof commands stay backed by package scripts", () => {
  const readme = readRepoText("README.md");
  const packageJson = JSON.parse(readRepoText("package.json"));

  // These commands are the normal local proof surface. Keeping README and
  // package.json aligned prevents a green audit from depending on stale docs.
  assert.match(readme, /npm run lint/);
  assert.match(readme, /npm test/);
  assert.match(readme, /npm run test:coverage/);
  assert.equal(typeof packageJson.scripts?.lint, "string");
  assert.equal(typeof packageJson.scripts?.test, "string");
  assert.match(packageJson.scripts?.["test:coverage"] ?? "", /--experimental-test-coverage/);
  assert.match(packageJson.scripts?.["test:coverage"] ?? "", /--test-coverage-include='src\/\*\*\/\*\.js'/);
  assert.match(packageJson.scripts?.["test:coverage"] ?? "", /--test-coverage-include='bin\/\*\*\/\*\.js'/);
});
