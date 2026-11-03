---
title: "AI Manager Claude and Codex compatibility with Herdr"
date: 2026-10-29
status: archived-prototype
---

# Herdr integration: prototype findings and remaining work

The October 29 investigation explored process detection, session reporting and
restoration through AI Manager. Its unfinished Claude process-name and resume-hint
changes were never included in the reviewed Claude runtime. During the November 3
repository reconciliation, those changes and their original plan were preserved
in the private repository archive rather than added to the approved launch path.
They are not current functionality or requirements of the privacy project.

The tested Herdr 0.9.0 server could detect interactive Claude and Codex sessions
and refuse a prompt at a blocking dialog, but could not retain a custom restore
command. A newer upstream session-report API could save a native session ID
before accepting the custom command. That partial update could make restoration
bypass AI Manager. Automatic account-safe restoration was therefore not enabled.

Any future restore work must verify that Herdr actually persists and uses the
AI Manager command, preserves user hooks and launch settings, and handles the
process-detection race, older servers, session changes and concurrent panes.
Codex rotation must create a fresh thread instead of sending an existing thread
ID under another account. The independent fix removing inherited
`CODEX_THREAD_ID` from `aim codex resume-fresh` is retained and tested; it does not
implement automatic Herdr restoration.

The other prototype, printing an exact Claude resume hint on exit, tracked the
vendor process's session record. It needs renewed verification against the
current native sandbox launch path before it can make that guarantee. Existing
history and explicit AI Manager resume commands remain the supported workflow.
