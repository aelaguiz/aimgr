# aimgr v2 proposal — per-label CLI homes, collapse the auth surface

Author: Claude (Opus 4.7), drafted 2026-04-20 from full ramp-up on current `src/cli.js`, README, and the live state of this consumer machine (`claudalyst@fun.country` → authority `agents@amirs-mac-studio`).

This is a **strawman**, not a final plan. The goal is to name the messes honestly, propose one big architectural shift that collapses several of them at once, and sketch the minimum changes to each surface.

---

## 1. What's actually broken (observed, not hypothetical)

### 1a. Four Anthropic labels, zero working Claude logins
`aim status` right now, on this box:

```
amir_claude_cratejoy_personal  reauth  native-claude  -40h  missing_credentials
amir_claude_fc_personal        reauth  native-claude  -40h  missing_credentials
amir_claude_personal           reauth  native-claude  -34h  missing_credentials
claudalyst                     reauth  native-claude  -40h  missing_credentials
CLAUDE active_label=amir_claude_personal  auth_method=none  auth_status=logged_out
WARNINGS: claude_target_missing_auth_file / email_mismatch / org_mismatch / not_logged_in / auth_method_mismatch
```

Every Claude label is `reauth`, `active_label` points at a label whose credentials AIM doesn't have, the "native bundle" for most labels was never captured on this host, and Claude itself is logged out. The machine has `~/.claude.json` but no `~/.claude/.credentials.json`.

This is not a one-off regression. It's the **steady state** of the current design: Claude auth is bound to "whoever last logged into the one global `~/.claude`," and AIM has no way to refresh it without a human physically logging into native Claude on each host, for each label, in sequence, into a directory that only holds one identity at a time.

### 1b. The auth-surface taxonomy has drifted
From `src/cli.js:23–30` and the legacy constants at 26–27:

- 3 reauth modes: `browser-managed`, `manual-callback`, `native-claude`
- 3 browser modes: `aim-profile`, `chrome-profile`, `agent-browser`
- 2 legacy browser constants still migrated on read (`aim-browser-profile`, `openclaw-browser-profile`)

What the live pool actually uses: **every** `openai-codex` label is `manual-callback`, every `anthropic` label is `native-claude`. `browser-managed` and all three browser-mode lanes are vestigial on this operator's pool. They're still wired through `aim browser set`, `aim <label>`'s guided panel, `resolveAgentBrowserCommand`, and the `~/.aimgr/browser/<label>/user-data` substrate — but nobody is using them.

### 1c. One `~/.claude` for N identities is structurally unsound
AIM currently owns only two things inside the Claude world:
- `~/.claude/.credentials.json` (full rewrite)
- `~/.claude.json` `oauthAccount` + onboarding flags (patched)

Everything else in `~/.claude/` — `projects/`, `todos/`, `settings.json`, MCP config, plugin cache, session env, shell snapshots, statsig, history — is shared across every identity AIM switches between. Commit `4404b27` ("Restore Claude onboarding flag on aim claude use after /logout") is the tell: AIM is already playing whack-a-mole with state that Claude Code owns but doesn't know it's being mutated across identities.

Rotation breaks for the same reason: Anthropic rotates refresh tokens in place on every successful refresh (see `preSwitchSync` at `src/cli.js:9897–9944`). That works only if the stored tokens and the live-file tokens are always about **the same identity**. The moment `aim claude use <otherlabel>` runs, the next refresh Claude performs mutates the *new* label's tokens, and AIM's stored copy of the *original* label silently goes stale.

### 1d. Shared pool, contested live homes
The Codex pool at `pool.openaiCodex` is consumed by four targets simultaneously:
- OpenClaw agents (`aim rebalance openclaw`)
- Local Codex (`aim codex use`)
- Local Pi (`aim pi use`)
- Hermes fleet (`aim rebalance hermes`)

All four read the same demand ledger and write into separate on-disk homes. That's fine in steady state. What's not fine is the **account-sharing story across machines**: the authority host owns the pool and ships labels to consumers via `aim sync codex --from`, but there's no structural reason the authority's label "boss" should mean the same physical account on the consumer as it does on the authority, and no single place that says "this label's credentials are currently rotating" vs. "this label is owned by consumer X for the next hour."

The workaround for that is `aim promote codex`, which is a pull-then-push-back-to-authority with CAS protection. It works, but it only triggers when a human remembers to promote. In practice this quietly breaks when rotation happens locally and nobody promotes.

### 1e. Claude's authority path has no remote refresh
`sync claude --from authority` only ships **already-captured native bundles** from authority to consumer. If the authority's bundle expires, nobody can refresh it from a consumer, because Anthropic refresh requires touching the live Claude process on some host. Today that host has to be the same host you want to use the label on, because the bundle is captured from local `~/.claude`.

---

## 2. Root causes, de-duped

1. **The single global CLI home is the wrong persistence unit.** Every pain above collapses into this. Claude Code, Codex, and Pi were each designed around "the user's one logged-in identity lives here." AIM is trying to multiplex N identities through 1 directory by atomically rewriting credentials files and hoping nothing else in the directory is identity-sensitive. That's a losing fight, and the Claude onboarding-flag drift is the canary.
2. **Legacy auth rails never got pruned when `manual-callback` + `native-claude` became canonical.** The browser-managed / agent-browser / chrome-profile / aim-profile lattice is cognitive overhead that doesn't pay rent.
3. **Authority/consumer is a half-finished distributed system.** Pull/push with CAS is good; fleet-wide "who owns rotation of label X right now" is not modeled at all, so rotation races are silent.

---

## 3. The v2 shift: per-label CLI homes as the persistence unit

### 3a. Core idea

Instead of:

```
AIM state  ──write──>  ~/.claude/.credentials.json          (shared, clobbered on switch)
                       ~/.claude.json oauthAccount          (shared, clobbered on switch)
                       ~/.codex/auth.json                   (shared, clobbered on switch)
                       ~/.pi/agent/auth.json                (shared, clobbered on switch)
```

we land on:

```
~/.aimgr/claude-homes/<label>/            (full Claude Code config dir, per-label, persistent)
~/.aimgr/codex-homes/<label>/             (full Codex home, per-label, persistent)
~/.aimgr/pi-homes/<label>/                (full Pi agent dir, per-label, persistent)
```

Each subdirectory is a **real, independent CLI home**: it gets logged in **once**, natively, and then stays logged in forever (modulo Anthropic's normal refresh-token rotation, which happens *inside* that dir and never collides with another identity). AIM's job is no longer "write the right credentials into the one global file"; it's "remember which per-label homes exist, keep them reachable, launch CLIs into the right one on demand, and sync their auth blobs across machines."

### 3b. How you invoke a CLI in v2

```bash
aim claude run boss [-- claude args…]         # launches claude with CLAUDE_CONFIG_DIR=~/.aimgr/claude-homes/boss
aim codex  run boss [-- codex args…]          # launches codex  with CODEX_HOME=~/.aimgr/codex-homes/boss
aim pi     run boss [-- pi args…]             # launches pi     with PI_CODING_AGENT_DIR=…/pi-homes/boss
```

Plus shell wrappers on `$PATH` so `claude-boss`, `codex-boss`, etc. just work from any shell. The global `~/.claude`, `~/.codex`, `~/.pi/agent` become **one more identity** ("the host's unlabeled identity") rather than the switching target. Nothing in v2 writes to those global dirs; they're legacy and AIM leaves them alone.

### 3c. What this collapses

- No more `preSwitchSync` rotation-capture logic. Rotation happens inside the label's own home and is never observed from "outside."
- No more onboarding-flag patching (`4404b27`). Each home gets onboarded once, stays onboarded.
- No more `claude_target_email_mismatch` / `claude_target_not_logged_in` / `claude_target_auth_method_mismatch` warnings. The target and the label are the same thing.
- No more "capture live native Claude from host" dance. The first-time login **is** the capture, and it writes into the right directory directly.
- No "next process vs. running process" contract on switching. You don't switch inside one process — you launch the one you want.
- No browser-binding substrate for Claude at all. Claude labels have one binding: "this directory."

### 3d. What this introduces

- **First-time login per label per machine is still manual.** You have to do `aim claude run boss` → `/login` inside Claude once, on each machine where you want that label live. This is not worse than today, and arguably better: it's the *only* manual step, and it's a one-time-per-label-per-machine cost instead of a daily-per-rotation cost.
- **`aim sync claude`** changes meaning. It no longer ships a "bundle" into AIM state; it rsyncs a tarball of `~/.aimgr/claude-homes/<label>/` from authority to consumer (or vice versa for promote). That works because the whole subdir is self-contained.
- **Label isolation cuts both ways.** Each Claude label has its own projects/, settings, MCP config. That's great for separation-of-concerns, but if the user *wants* shared MCP config across labels, we need a symlink or overlay story. Flag as open question (§7).

### 3e. What Codex and Pi gain

`CODEX_HOME` and `PI_CODING_AGENT_DIR` already exist and are honored. Today AIM uses them for tests (`CODEX_HOME=/tmp/…`) but not for per-label isolation. Moving to per-label homes for Codex and Pi is mostly cost-free because those CLIs genuinely support it — AIM just has to write into the right subdir and launch with the right env. The `auth.json`-only model stays; `codex-homes/<label>/` mostly contains `auth.json` plus whatever state Codex itself keeps.

### 3f. What Hermes gets

Hermes already has per-profile homes (`~/.hermes/profiles/<id>/`). v2 just formalizes the symmetry: Hermes profiles and local per-label CLI homes are the *same kind of thing*, just owned by different runtimes. `aim rebalance hermes` keeps working as-is; it's the one place the current design was already on the right side of this shift.

### 3g. What OpenClaw gets

OpenClaw is out of scope for the core v2 shift — it's not a local CLI with a home dir, it's a gateway that consumes assignments. Keep `aim rebalance openclaw` and `aim sync openclaw` as they are. The only v2 change OpenClaw sees is: stop caring about browser modes on Codex labels, because Codex doesn't need them.

---

## 4. What dies in v2

Delete (not deprecate — delete):

- `BROWSER_MODE_AIM_PROFILE`, `BROWSER_MODE_CHROME_PROFILE`, `BROWSER_MODE_AGENT_BROWSER`
- `LEGACY_INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE`, `LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE`
- `REAUTH_MODE_BROWSER_MANAGED`
- `resolveAgentBrowserCommand`, `activateAgentBrowserApp`, `formatBrowserLaunchFailure`
- `~/.aimgr/browser/<label>/user-data` substrate
- `aim browser set`, `aim browser show` (collapsed into `aim <label>` setup flow)
- `aim claude capture-native`, `aim claude export-live`, `aim claude import-native`, `preSwitchSync` — replaced by rsync-the-dir
- Per-label `oauthAccount` patching and onboarding-flag fixup in `~/.claude.json`

Keep:

- `manual-callback` as the only Codex reauth mode. Rename to just "codex-oauth" or similar — the "manual" qualifier only existed to contrast with the browser-managed lane that's going away.
- `native-claude` semantics, but the implementation is now "you logged into this label's home dir once"
- Authority/consumer sync and promote (but the payload changes from credential blobs to whole-dir rsyncs for Claude)
- The pool ledger, weighted allocator, watch/rebalance paths for Codex
- `aim <label>` as the human front door (panel simplifies to "reauth / run / details")

---

## 5. Command surface after v2

```bash
aim status                                    # unchanged contract, simplified warnings
aim <label>                                   # guided panel: reauth, run, details
aim login <label>                             # one-shot reauth for scripts
aim claude run <label> [-- args…]             # new primary Claude invocation
aim codex  run <label> [-- args…]             # new primary Codex invocation
aim pi     run <label> [-- args…]             # new primary Pi invocation
aim rebalance openclaw                        # unchanged
aim rebalance hermes                          # unchanged
aim codex  watch [--once …]                   # unchanged (watches the OpenClaw/Hermes-consumed pool)
aim hermes watch [--once …]                   # unchanged
aim sync claude --from <authority>            # now = rsync labeled homes from authority
aim sync codex  --from <authority>            # unchanged semantics, same auth.json payload
aim promote claude --to <authority> <label>   # now = rsync labeled home back
aim promote codex  --to <authority> <label>   # unchanged
```

Gone: `aim claude use`, `aim codex use`, `aim pi use`, `aim browser *`, `aim claude capture-native`, `aim claude export-live`, `aim claude import-native`. `use` becomes `run` because there's no "activate the global CLI for the next process" anymore — you just run the right one.

---

## 6. Migration plan

**Phase 0 — CLAUDE_CONFIG_DIR ground truth (verified 2026-04-20).**
Confirmed empirically against Claude Code 2.1.114: setting `CLAUDE_CONFIG_DIR=/tmp/aim-cdir-test.kPJZy5` and running `claude mcp list` produced `/tmp/aim-cdir-test.kPJZy5/.claude.json` (151 bytes, 4 keys, no `oauthAccount`, no `hasCompletedOnboarding`, no `userID`) plus `/tmp/aim-cdir-test.kPJZy5/backups/`. The real `~/.claude.json` was untouched (mtime + sha unchanged across runs). Conclusion: `CLAUDE_CONFIG_DIR` is a **complete** isolation boundary — both the `~/.claude/` directory and the `~/.claude.json` sibling file relocate under it, and Claude Code does not fall back to reading the global `.claude.json` when `CLAUDE_CONFIG_DIR` is set. Per-label Claude homes are viable. Do NOT use `claude auth status` in any AIM codepath to verify login state — the aimgr README already flags that it mutates files during read, and nothing in this test contradicts that.

**Phase 1 — Codex + Pi first (cheap, low risk).**
Both have real env-var support. Introduce `~/.aimgr/codex-homes/<label>/` and `~/.aimgr/pi-homes/<label>/`, add `aim codex run` / `aim pi run`, ship wrappers, keep `aim codex use` as a deprecated alias that populates *both* the per-label home and the legacy global home. Two weeks of dual-write to shake out bugs, then drop the global-home write.

**Phase 2 — Claude cutover.**
Introduce `~/.aimgr/claude-homes/<label>/`. Add `aim claude run`. On first run for a label with no home, print a one-screen "you need to `/login` inside this Claude, then exit, then re-run; this is a one-time setup" message. Remove the `aim claude use` path entirely — there is no useful alias here because the old contract genuinely doesn't exist in v2. Add `aim claude promote <label>` via rsync so users can seed a fresh host from authority instead of re-doing `/login` on every box.

**Phase 3 — kill the browser infrastructure.**
After Codex + Claude are cut over, delete the browser-mode lattice, the `aim browser *` commands, the `~/.aimgr/browser/` substrate, and the legacy constants. This is the big LOC reduction pass — plausibly half the `cli.js` file.

**Phase 4 — rename and document.**
`aim claude capture-native`, the `native-claude` string literal, `preSwitchSync`, the `claude_target_*` warning set — these are all fossils of the one-global-home assumption. Rename and prune.

At the end of all four phases, `src/cli.js` should be substantially smaller and every warning `aim status` currently emits about Claude should be either impossible-by-construction or mean something actionable.

---

## 7. Open questions

1. ~~**Does `~/.claude.json` move with `CLAUDE_CONFIG_DIR`?**~~ Verified 2026-04-20 — yes, full relocation. See Phase 0 above.
2. **Shared MCP config across Claude labels.** Per-label isolation is great for credentials, annoying if the user has a single MCP registry they want all labels to use. Proposal: put the shared config in `~/.aimgr/claude-shared/` and symlink selected files (`~/.claude.json`'s `mcpServers` key, or `~/.claude/settings.json`) into each label's home. Revisit after Phase 2 based on felt pain.
3. **Authority Claude without a live Claude on authority.** If `amirs-mac-studio` itself never runs Claude interactively, how does the authority ever own a Claude login to propagate? Options: (a) authority *does* run Claude at least once per label per rotation (a few minutes every N weeks), (b) any consumer can promote its login back, and "authority" is a naming convention rather than a physical root. Prefer (b).
4. **Pool partitioning.** The user explicitly said "huge pool for hermes agents, but I actually burn most tokens locally." Worth a side proposal: should some labels be marked `purpose: hermes-only` vs `purpose: local-only` vs `purpose: shared`, so `aim rebalance hermes` and `aim codex run` don't fight? Not a v2 blocker, but cheap to add once per-label homes exist, because purpose becomes a per-label property in one place.
5. **Fleet-wide rotation ownership.** Today rotation is silently last-writer-wins. A lightweight lease ("this machine holds refresh rights for label X until T") recorded in authority state would fix it without full distributed-lock complexity. Flag as post-v2.
6. **What to do with the 4-hour-old `amir_claude_*` creds that are currently expired on this box.** Orthogonal to the design doc, but the concrete next step if the user wants this machine working today is: pick one Claude label, log into it natively into `~/.claude`, `aim claude capture-native <label>`, and use that one until v2 lands.

---

## 8. The one-paragraph version

The current design treats `~/.claude`, `~/.codex`, and `~/.pi/agent` as mutable projections of AIM state, and every single Claude pain point — rotation breaking, onboarding flags drifting, email/org mismatches, the need for `capture-native`, the "next process not hot-swap" contract, the preSwitchSync rotation detector — falls out of that one choice. v2 inverts it: AIM owns a directory per label, the CLI is invoked against that directory, and the global homes become legacy. Doing this kills roughly half the codebase (the entire browser-binding lattice and the Claude native-bundle dance), removes every current `aim status` warning by construction, and makes cross-machine account sharing a plain rsync instead of a credential-projection protocol. The one real cost is a once-per-label-per-machine `/login` into Claude — paid upfront, not per-rotation.
