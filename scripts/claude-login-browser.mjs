#!/usr/bin/env node
import { openClaudeLoginInChrome } from "../src/browser/claude-cdp.js";

try {
  const profile = JSON.parse(process.env.AIMGR_CLAUDE_LOGIN_PROFILE ?? "null");
  if (!profile || process.argv.length !== 3) throw new Error("missing login binding");
  await openClaudeLoginInChrome(profile, process.argv[2], { receiptPath: process.env.AIMGR_CLAUDE_LOGIN_TABS });
// Do not invoke open/default browser on failure: it could send the OAuth URL
// from the normal IP. Denial stays visible to native login and its caller.
// Regression: test/network/claude-chrome.test.js (binding and tunnel denial).
} catch {
  process.stderr.write("Claude login could not open its assigned Chrome instance. Check the account's Chrome/CDP/SOCKS configuration.\n");
  process.exitCode = 1;
}
