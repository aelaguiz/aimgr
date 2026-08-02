# AIMGR Single-Operator Friction Review

Date: 2026-08-02

Scope: current `main` at `3ef27585fba642b6a9cf8bcdcf4f27ef0292ab0b`

Disposition: discussion only; no runtime behavior changed

## Requirements at the top

1. AIMGR is a private internal developer tool for Amir, one trusted operator. It is not a public or adversarial multi-tenant product.
2. Preserve the features Amir uses: Redis-backed Claude/Codex accounts, status, least-use and explicit selection, native launch flags, per-account containment, refresh/reauth, session list/resume/fork/switch, exact model/effort, custom skills/MCPs/plugins/hooks, and fleet use.
3. AIMGR must not freeze, kill, or refuse useful local work because Redis, Tailscale, provider usage, optional configuration, or wrapper coordination is temporarily unavailable.
4. Keep only protections that prevent a real loss: secret disclosure, stale credential overwrite, rotating-token lineage corruption, wrong-account projection, or concurrent online use of the same refresh token.
5. No additional scope. Simplify the mechanisms already serving the goal; do not add a new daemon platform, policy framework, database, event system, or configuration registry.

## Bottom line

The architecture is **not approved as the minimal private-tool shape**. AIMGR has the right user-facing features, but too many internal mechanisms have become permission gates. The requested change is subtraction and consolidation, not removal of working features.

One important correction to the latest hotfix: lease-renew failure no longer pauses Claude, but `startClaudeActiveRotationPublisher()` can still abort the live Claude child on any storage/publication/Redis exception. The wrapper also kills Claude when AIM's IPC parent disappears. The core “coordination must not own my terminal” problem is therefore reduced, not finished.

## Cut first: mechanisms that can stop work

| Rank | Overbuild | What it does today | Keep the feature; remove the interference |
|---|---|---|---|
| 1 | Coordination owns the Claude process | Active publication errors and wrapper-parent loss can terminate the TUI; dead pause/resume SIGSTOP/SIGCONT machinery remains. | Keep one online same-account lease and CAS. Publication failure becomes dirty state plus retry; it never controls the TUI. Remove dead pause IPC and parent-death termination policy. |
| 2 | Six-way rotation recovery | Redis record/version, a separate fence, local pending marker, native file, active-target metadata, and duplicate OAuth copies can disagree and block the next launch. | Keep one canonical native OAuth bundle and one visible recovery record tied to the base Redis version and origin. Mutate canonical state only after CAS succeeds. |
| 3 | Ephemeral local credentials | AIMGR deletes the managed credential after a clean run, making every run/resume depend on live Redis and recreating projection/recovery work each time. | Keep a private versioned per-label runtime cache. Redis remains fleet authority; explicit offline local resume shows `coordination=offline` and the same-label risk. |
| 4 | Inconsistent Redis failure policy | Some calls are bounded; others use indefinite reconnect defaults; stale status expires after one hour; the same outage can hang, fail, hide local state, or kill a child. | Use three explicit modes: bounded observation, bounded one-shot mutation, and reconnecting long-run after bounded initial attach. Render shared/local/usage sections independently as live/stale/unavailable. |
| 5 | Telemetry is treated as authorization | Fresh provider usage is forced before blind launch; unreadable usage can reject every credential or clear/block a valid target. | Credential readiness and usage readability become separate facts. Explicit labels bypass usage; automatic selection uses fresh then labeled stale usage and never erases valid auth because telemetry failed. |

## Cut next: wrapper policy that changes the development environment

| Rank | Overbuild | What it does today | Keep the feature; remove the interference |
|---|---|---|---|
| 1 | Blanket macOS `security` shadow | The Keychain workaround intercepts `security` for Claude and every descendant; it rejects certificate verification and unknown operations. It runs seven self-tests every launch. | Keep Keychain-free file OAuth. Prefer an upstream file-store switch; otherwise intercept only Claude's credential service and delegate everything else to `/usr/bin/security`. Build/test once at install. |
| 2 | Second package manager | AIMGR pins one Linux version/hash, enforces macOS signature/topology, and disables Claude's updater. Official upgrades have repeatedly become launch outages. | Resolve the operator-selected executable and run it. Require executable access; make provenance a warning, not a blocker. Stop disabling updates. |
| 3 | Broad environment scrub | AIMGR clears base URLs, custom headers, and DYLD/LD/debug variables for the entire process tree. | Clear only competing Claude credential/backend selectors. Preserve the user's developer environment for hooks, MCPs, builds, and nested agents. |
| 4 | Optional customization is a hard gate | AIMGR reparses plugin internals, requires exact cache/install topology, owns an ADHD-plugin preference, and can reject malformed skills/MCP/hook/plugin state before Claude starts. | Keep automatic inheritance through one generic best-effort overlay/share owner. Credentials stay strict; optional customization is skipped/reported or diagnosed by Claude. |
| 5 | Global native-flag parser | AIMGR rejects new upstream dash flags unless added to its parser or placed after `--`; presets compensate one flag at a time. | Parse the small AIMGR command/account/preset prefix, then pass the remainder to Claude/Codex untouched. |

## Consolidate daily behavior

| Rank | Split ownership | Current cost | Smaller owner |
|---|---|---|---|
| 1 | Redis versus `secrets.json` | A missing Redis URL silently resurrects the retired local credential store as live authority. | Redis is the only runtime credential authority. Legacy files exist only behind an explicit migration/recovery command. |
| 2 | General status versus Claude status | Default `aim status` computes browser, OpenClaw, Hermes/Pi, pressure/projection, authority-import, and duplicate Claude models that it does not render. | One provider account snapshot each; a small default assembler; expensive legacy diagnostics only behind explicit options/commands. |
| 3 | Codex use versus watch versus Tend | Three paths disagree about preserving, publishing, or overwriting a native Codex refresh. | One identity/freshness reconciliation operation used by every Codex entry point. |
| 4 | Interactive launch versus auth maintenance | The 60-second maintainer re-enters the entire Claude CLI launcher, customization, supervisor, and nested Redis runtime for a due credential. | One small due-record service uses official-client refresh, a timeout, one lease, CAS, and safe per-label outcome. |
| 5 | CLI command graph and errors | Every invocation loads unrelated handlers and migration code; expected errors escape as Node stacks; some Redis URLs can evade generic redaction. | Lazy-load one command, add one redacted error boundary, retain opt-in debug stacks, and share endpoint-aware redaction. |

## Retire only confirmed dead or completed paths

| Surface | Current status | Disposition |
|---|---|---|
| Codex Tend | Amir explicitly recorded it as broken and dead; roughly 2,175 lines of tender/lock/PTY/relay machinery remain. | Retire it without replacing it. Preserve ordinary Codex run/use/watch features that are actually used. |
| Redis migration engine | The breaking cutover is complete, but one-time collection/planning/apply code is eagerly loaded. | Move it behind an explicit recovery/migration entry or archive it after fleet/backups are confirmed. |
| Removed command routes | `apply`, `sync`, `promote`, `session`, `pin`, `autopin`, and other compatibility stubs remain in the active router; one redirect recommends another removed command. | Remove or time-box them after confirming no current invocation. |
| Old Keychain capture compatibility | Still potentially useful for adding an account whose native credential has not been enrolled. | Keep it isolated until the current native login/import path covers every account; do not load it in normal run/status. |
| Browser/re-auth alternatives | Code alone does not prove which visible login lane is still used. | Do not delete by inference. Inventory actual use first, then preserve one canonical lane. |

## Protections that are real and stay

1. Secret- and endpoint-aware redaction plus private (`0600`) credential files.
2. Stable account identity validation when a credential is enrolled or replaced.
3. Redis compare-and-swap so an older machine cannot overwrite a newer credential.
4. One online per-label lease because official OAuth refresh tokens rotate and concurrent refresh can clobber lineage.
5. One crash-recovery marker for a token rotated locally but not yet published.

These constraints stop actual credential loss. They do not justify policing executable versions, plugin layouts, terminal lifetime, usage freshness, shell tools, or the operator's intentional command choices.

## Smallest coherent target

1. **Thin CLI:** resolve one command, parse AIMGR-owned prefix arguments, pass native arguments through, print one actionable redacted error.
2. **One provider snapshot:** Redis account/credential facts plus cached/live usage provenance, shared by status and selection.
3. **One per-label runtime owner:** versioned local native cache, online lease, native-client execution, change observation, CAS publication, and one dirty recovery state.
4. **Transparent contained environment:** per-label Claude config/session root with the real user HOME and generically shared customizations; a narrow file-store adapter only where macOS requires it.
5. **Small maintainer:** retry due official-client refresh, publish if newer, mark reauth only on real terminal auth failure, and otherwise try again later.

## Recommended subtraction order

1. Decouple the live Claude child from active publication, Redis transport, dead pause IPC, and wrapper-parent failure while retaining online lease/CAS integrity.
2. Collapse Claude token/recovery truth and retain the versioned per-label local cache.
3. Remove binary/update/environment policing and narrow the macOS file-store adapter; make optional customization best-effort.
4. Unify status/selection/Codex reconciliation/maintenance and bound Redis failure behavior.
5. Remove the legacy authority side door, Tend, and confirmed-unused migration/removed-command hot paths.

## Evidence and detailed review

The full standalone review artifact is at:

`/tmp/cynical-architecture-review/aimgr-single-user-friction-20260802T150028Z/`

It contains the target, architecture map, complexity ledger, subtraction map, coverage accounting, source-cited findings, and verdict. The earlier narrow network-control analysis remains at `docs/bugs/AIM_MANAGED_CLAUDE_NETWORK_COORDINATION_OVERBUILD_2026-08-02.md`; this document supersedes it as the holistic discussion surface.
