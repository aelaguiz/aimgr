---
title: Keep Figma MCP signed in under AI Manager
date: 2026-11-25
status: active
doc_type: project_plan
---

# Keep Figma MCP signed in under AI Manager

One Figma authorization in BrowserOS Work enables Figma’s remote MCP in new AI Manager Claude sessions on that machine. AIM renews the grant through a Figma-specific launchd or systemd user timer installed at enrollment. Claude reloads the access token if a running session must reconnect.

Each machine owns its grant. The Figma exchange and refresh use the approved native Claude Code runtime and file-backed storage. The grant stays independent of Claude account credentials. Sessions with an assigned Claude proxy keep the existing routing boundary and receive only their existing MCP configuration.

[GitHub issue #43](https://github.com/aelaguiz/aimgr/issues/43)

## Evidence and launch points

- Manual testing established live Figma identity through the normal protected AIM launcher, a second machine with a separate grant, native refresh against Figma, and same-session retry after a controlled HTTP 401.
- Claude Code supports Figma’s official remote server and dynamic HTTP authorization headers. It reruns the header helper on a rejected tool request. [Figma remote setup](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) · [Claude dynamic headers](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication)
- [Claude launch](../src/targets/claude-runner.js) builds native arguments for normal runs and resumes. [Claude privacy admission](../src/privacy/claude-native-invocation.js) selects exact approved artifacts and constrains native launches. The pilot Mac and Linux host had no general AIM auth maintenance job. The Figma timer invokes the stable AIM wrapper every 15 minutes and starts with the user service manager.
- [Release installation](../scripts/install-release.sh) activates committed releases through devcluster. Existing native Claude sessions carry the release they started with.

## Phase 1. Persist the grant and renew it

Add `aim claude figma login --email <work-email>` and `aim claude figma status [--json]`. Login stages a dedicated Figma-only Claude home, runs native MCP consent with the browser disabled, verifies the Figma identity through `whoami`, and publishes the grant atomically. Reuse the native privacy launcher for the isolated home. A refresh runs on a staging copy, joins one machine-local lock, and publishes only a successful renewal. Keep a previous usable grant if login or refresh fails. Renew within a day of expiry, with no Figma traffic on routine healthy checks. Keep the schedule in the OS user service manager so a new AIM release takes effect automatically.

## Phase 2. Supply Figma to Claude sessions

AIM supplies the official server as `figma-work` to enrolled machines’ ordinary Claude launches. The helper emits only the current access token to Claude for that server and endpoint. Preserve explicitly supplied strict MCP configurations, assigned proxy routes, and existing user servers. Clear the stale cache entry for this managed server when its grant can be used. Keep credentials outside settings, logs, and Redis.

## Phase 3. Release and enroll

Run focused tests, repeat the protected launch and forced refresh on a Mac canary, then ship through the normal AIM release path. Authorize a separate grant for each configured AIM host from BrowserOS Work and check actual connection state. Use only the known authorized Claude label for any live model verification. Record installed and enrolled hosts, transient blockers, and proof in the work log. Existing account and project MCP configurations continue to work.

## Acceptance evidence

1. Two new managed Claude sessions on an enrolled machine can access the same Figma account without a second browser login.
2. The auth maintainer renews an expiring grant and preserves it on transient failure.
3. A new release installs through devcluster, and the configured fleet’s Figma enrollment is verified host by host.

## Canary results

The reviewed Claude Code runtime authorized a file-backed grant through
BrowserOS Work. A direct Figma identity check passed, then a forced native
renewal extended the grant and the live identity check passed again. A
standard managed Claude launch connected to `figma-work` and called
`whoami` successfully. Focused tests exercised wrong-account rollback,
concurrent renewal, stale auth-cache cleanup, and proxy and strict
configuration exclusions.
