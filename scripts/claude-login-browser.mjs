#!/usr/bin/env node
import { openClaudeLoginInChrome } from "../src/browser/claude-cdp.js";

try {
  const profile = JSON.parse(process.env.AIMGR_CLAUDE_LOGIN_PROFILE ?? "null");
  if (!profile || process.argv.length !== 3) throw new Error("missing login binding");
  await openClaudeLoginInChrome(profile, process.argv[2], { receiptPath: process.env.AIMGR_CLAUDE_LOGIN_TABS });
} catch {
  process.stderr.write("Claude login could not open its assigned Chrome instance. Check the account's Chrome/CDP/SOCKS configuration.\n");
  process.exitCode = 1;
}
