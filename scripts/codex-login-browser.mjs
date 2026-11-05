#!/usr/bin/env node
// Run on the original browser host, connected to the headless login's private
// JSONL handoff. Validate before allowing that caller to start/release its URL;
// the open action validates again immediately before its first navigation.
import os from "node:os";
import { codexProxyProfiles, readAimgrConfig } from "../src/config/aimgr-config.js";
import { resolveCodexBrowserProfile, validateCodexChrome, openCodexLoginInChrome } from "../src/browser/codex-cdp.js";
import { readNonEmptyLineFromStdin } from "../src/cli/manual-callback-stdio.js";

try {
  const [action, profileRef] = process.argv.slice(2);
  if (!["validate", "open"].includes(action) || process.argv.length !== 4) {
    throw new Error("Usage: codex-login-browser.mjs validate|open PROFILE (open reads one private auth_url JSONL event)");
  }
  const profile = resolveCodexBrowserProfile({ label: profileRef, egress: { profileRef },
    profiles: codexProxyProfiles(readAimgrConfig({ homeDir: os.homedir() }).config) });
  if (action === "validate") {
    await validateCodexChrome(profile);
    process.stdout.write(JSON.stringify({ type: "browser_ready", profileRef }) + "\n");
  } else {
    const event = JSON.parse(await readNonEmptyLineFromStdin(process.stdin));
    if (event.type !== "auth_url" || event.provider !== "openai-codex") throw new Error("Expected a Codex auth_url event");
    const tab = await openCodexLoginInChrome(profile, event.url);
    try {
      process.stdout.write(JSON.stringify({ type: "browser_opened", profileRef }) + "\n");
      // The private handoff owner closes stdin when login completes or fails.
      // This process owns that one tab for the same bounded login lifetime.
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGTERM", stop); process.once("SIGINT", stop);
      const timer = setTimeout(() => controller.abort(), 10 * 60_000);
      try { await readNonEmptyLineFromStdin(process.stdin, { signal: controller.signal }); }
      catch (error) { if (!process.stdin.readableEnded) throw error; }
      finally { clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop); }
    } finally { await tab.close(); }
  }
} catch (error) {
  process.stderr.write(`Codex login browser handoff failed: ${error.message}\n`);
  process.exitCode = 1;
}
