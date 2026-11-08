#!/usr/bin/env node
import fs from "node:fs";
import { openClaudeLoginInChrome } from "../src/browser/claude-cdp.js";

try {
  const profile = JSON.parse(process.env.AIMGR_CLAUDE_LOGIN_PROFILE ?? "null");
  if (process.env.AIMGR_CLAUDE_LOGIN_STDIO_URL) {
    if (process.argv.length !== 3) throw new Error("missing native authorization URL");
    fs.writeFileSync(process.env.AIMGR_CLAUDE_LOGIN_STDIO_URL, JSON.stringify({url:process.argv[2]}), {mode:0o600,flag:"wx"});
    process.exit(0);
  }
  if (!profile || process.argv.length !== 3) throw new Error("missing login binding");
  await openClaudeLoginInChrome(profile, process.argv[2], { receiptPath: process.env.AIMGR_CLAUDE_LOGIN_TABS });
// Do not invoke open/default browser on failure: it could send the OAuth URL
// from the normal IP. Denial stays visible to native login and its caller.
// Regression: test/network/claude-chrome.test.js (binding and tunnel denial).
} catch {
  process.stderr.write("Claude login could not open its assigned Chrome instance. Check the account's Chrome/CDP/SOCKS configuration.\n");
  process.exitCode = 1;
}
