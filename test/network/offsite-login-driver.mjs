// Development-only bridge for a Linux test CLI and an existing local browser.
// The control host validates the real browser with validateClaudeChrome, writes
// its non-secret binding receipt here, and opens the resulting URL with the
// actual local browser helper. No browser state or cookies move to this host.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../../src/cli.js";
import { runClaudeCli } from "../../src/targets/claude-runner.js";

const label = process.argv[2];
const directory = process.env.AIMGR_OFFSITE_LOGIN_DIR;
assert.equal(process.platform, "linux");
assert.ok(["proxy5", "proxy6"].includes(label), "Only the two sacrificial accounts are permitted");
assert.ok(directory && path.isAbsolute(directory), "A private test handoff directory is required");
assert.equal(fs.statSync(directory).mode & 0o077, 0);
const receipt = JSON.parse(fs.readFileSync(path.join(directory, `${label}-browser.json`), "utf8"));
assert.equal(receipt.label, label);
assert.equal(receipt.validated, true);
const urlPath = path.join(directory, `${label}-url.txt`);
const capturePath = path.join(directory, `${label}-capture.mjs`);
assert.equal(fs.existsSync(urlPath), false, "Do not reuse an earlier authorization URL");
fs.writeFileSync(capturePath, `#!${process.execPath}
import fs from "node:fs";
if (process.argv.length !== 3 || new URL(process.argv[2]).protocol !== "https:") process.exit(1);
fs.writeFileSync(${JSON.stringify(urlPath)}, process.argv[2], { mode: 0o600, flag: "wx" });
`, { mode: 0o700 });

await main(["login", label], {
  // Browser validation ran on its actual host immediately before this test.
  // All native routing, OAuth, staging, lease and publication code stays real.
  validateClaudeChromeImpl: async profile => {
    assert.equal(profile.label, receipt.label);
    assert.equal(profile.profileRef, receipt.profileRef);
    assert.deepEqual([...profile.expectedExits].sort(), [...receipt.expectedExits].sort());
  },
  runClaudeCliImpl: options => runClaudeCli({
    ...options,
    env: { ...options.env, BROWSER: capturePath },
  }),
});
