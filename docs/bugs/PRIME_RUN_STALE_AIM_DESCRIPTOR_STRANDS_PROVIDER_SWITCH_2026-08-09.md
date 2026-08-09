---
title: Prime provider switch is stranded by a stale AIM ownership receipt
date: 2026-08-09
status: resolved
owners: [aimgr]
reviewers: []
related:
  - docs/AIMGR_PI_PRIME_CREDENTIAL_BROKER_INTEGRATION_2026-08-06.md
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** `aim prime run codex` refuses to uninstall Anthropic because the live descriptor differs from AIM's last receipt; the next `aim prime run claude` refuses because the failed uninstall was persisted as pending.
- **Impact:** an ordinary Prime provider switch cannot launch, and each failed command can partially mutate the other provider before stopping.
- **Most likely cause:** a long-lived AIM command can write an old full `targets` snapshot back to local state after another process has changed Prime. The uninstall path then treats a different but valid AIM descriptor as foreign and persists `uninstall/prepared` before checking that refusal condition.
- **Next action:** none; the receipt-driven state machine and its CLI gate were removed.
- **Status:** resolved

<!-- bugs:block:analysis -->
## Bug North Star

`aim prime run codex|claude` must switch the managed provider and launch it. AIM-owned label drift or another AIM process ending must not create a false ownership conflict, a sticky pending transition, or a partially applied provider switch.

## Bug summary

The protection is firing on AIM's own descriptor, not on native or foreign auth. The live Anthropic entry is a valid AIM external descriptor for `pro7`; the local ownership receipt still says `pro8`. Uninstall requires byte-for-byte equality with the stale receipt even though install already treats the AIM descriptor marker as sufficient ownership proof.

The refusal itself is then made durable: uninstall stores `pendingTransition={operation: uninstall, phase: prepared}` before it checks equality. The next install therefore cannot repair/re-adopt the valid live descriptor and exits with `Finish the pending anthropic uninstall before installing a binding.`

## Evidence

### Live state (2026-08-09)

`aim prime status` reported:

- Anthropic `managedEntryPresent: true`, live binding `pro7`, `recordReady: true`.
- Anthropic local state `installed: false`, `ownershipConflict: true`.
- Anthropic pending transition `uninstall / prepared`.
- The native backup still exists at the expected private backup path.
- Codex had already been restored to native auth by the second provider-switch attempt.

A direct non-secret comparison of `~/.prime/agent/auth.json` with `~/.aimgr/local-state.json` showed that all descriptor structure matched; only `binding` and the corresponding identity fingerprint differed: live `pro7`, receipt `pro8`.

### Stale-state provenance

Timestamped local-state backups show that Prime's receipt was current at `pro7` through 09:05, then was replaced by an older `pro8` snapshot whose `lastInstalledAt` remained `2026-08-09T01:33:33.625Z`. The only differences between the two snapshots were the Prime Anthropic binding, descriptor/fingerprint, timestamp, and selection receipt. This is a lost update, not a native-login replacement.

The generic writer in `src/coordination/runtime.js:63-82` serializes all `state.targets` from the caller's in-memory view. A managed Claude run writes once before launch and again after the interactive process exits (`src/cli/commands/claude.js:733` and `:794`). That second write can be hours later and can replay stale state for unrelated targets such as Prime.

### Uninstall poisoning

`src/targets/harness-auth.js:507-518` persists `uninstall/prepared` before `:540-545` checks exact equality with `lastInstalledDescriptor`. Consequently a normal refusal is recorded as crash-recovery work even though no auth mutation began.

The install path explicitly has the opposite ownership rule at `src/targets/harness-auth.js:328-343`: any valid AIM external descriptor is recognized as AIM-owned because local state is only a recovery aid. Uninstall does not apply that rule.

### Partial command application

Prime shorthand expands to two provider operations (`src/cli/commands/harness-target.js:209-213`) and applies them sequentially (`:264-318`):

- `run codex` installs Codex before attempting to uninstall Anthropic, so the first failure leaves Codex installed and Anthropic pending.
- `run claude` then uninstalls Codex before trying Anthropic, where it hits the pending-uninstall guard.

The intervening `codex -p yolo` command is unrelated; it does not own `~/.prime/agent/auth.json` or AIM's Prime target receipt.

### Deterministic repro

A temporary-directory repro performed these steps without touching live auth:

1. Install AIM Anthropic `pro8` over native auth and retain that state as a stale view.
2. Switch the same live AIM descriptor to `pro7` through `installHarnessProvider`.
3. Uninstall through the stale `pro8` view.
4. Attempt a new install through that view.

Observed results exactly matched the report: uninstall refused on exact equality, left `uninstall/prepared`, and the next install refused to proceed until that pending uninstall was finished.

## Investigation and ranked hypotheses

1. **Confirmed primary cause — stale full-target lost update.** A long-running command can write an old `targets` snapshot after another process has updated Prime. The backup timeline and the generic full-target post-run write establish a concrete path.
2. **Confirmed failure amplifier — inconsistent AIM ownership rules.** Install can re-adopt any valid AIM descriptor; uninstall only accepts the exact stale receipt. The current live entry is valid AIM-managed auth, so the guard protects no native or foreign value in this incident.
3. **Confirmed stranding bug — pending is persisted before validation.** A rejected precondition becomes durable recovery state and blocks the repair path.
4. **Confirmed partial-effect bug — provider shorthand is not preflighted as one switch.** The two operations can stop between providers, making each retry mutate a different half of the intended state.

## Suspected blast radius

- Both Pi and Prime use `uninstallHarnessProvider`, so valid AIM label drift can strand either target.
- Any long-running command that calls `writeRedisLocalStateFromView` after returning from the child process can overwrite unrelated local target state. The evidenced path is managed Claude post-run.
- Native backups were retained in this incident; no credential secret was lost. The functional blast radius is provider switching and incorrect local ownership receipts.

## Scope and simplicity contract

- **Human-authorized corrected behavior:** ordinary `aim prime run codex|claude` must just switch and launch. Harness auth must not block the user on a local ownership receipt, exact-descriptor comparison, or pending-transition recovery state.
- **Smallest sufficient fix:** make the live auth entry authoritative; delete `lastInstalledDescriptor` and `pendingTransition` from harness install/uninstall/status; replace or remove AIM descriptors directly; leave an already-native/foreign entry untouched during uninstall; retain only the deterministic displaced-native backup needed to restore direct native auth, and never use that backup or local target state as a gate.
- **Initial minimal convergence closure:** remove receipt-dependent install, uninstall, and status behavior together so no competing receipt path can still block Pi or Prime. Stop the evidenced managed-Claude post-run write from replaying an old full target snapshot. No general transaction framework or new state store.
- **Scope freeze:** re-frozen after the user's explicit request to remove receipt/protection gating.
- **Enough proof:** focused tests show stale/stranded legacy receipt state is ignored, a live AIM descriptor always switches/uninstalls, native auth is restored when a deterministic backup exists, foreign/native live auth is left untouched without error, and a managed Claude process ending cannot roll back unrelated Prime target state.
- **Do not build:** no replacement receipt, lineage history, recovery state machine, distributed transaction coordinator, compatibility fallback, or exact-match ownership guard.
- **Accepted residual risk:** malformed auth files still fail loudly; already-running Prime sessions keep their session binding semantics.

<!-- bugs:block:fix_plan -->
## Fix plan

1. Delete harness provider ownership receipts, exact-descriptor comparison, and pending install/uninstall transitions.
2. Make the live auth entry authoritative: AIM descriptors switch/remove directly; native or foreign live entries never block uninstall.
3. Keep only a passive deterministic native backup so direct native auth can be restored without becoming a gate.
4. Remove the `--replace-native-auth` permission gate; an explicit AIM selection performs the replacement it requested.
5. Stop managed Claude from replaying a stale full local-target snapshot after its child process exits.
6. Replace state-machine tests with direct behavior tests, including the exact reported Prime switch.

<!-- bugs:block:implementation -->
## Implementation and verification

Implemented:

- `src/targets/harness-auth.js`
  - removed `lastInstalledDescriptor`, `pendingTransition`, exact ownership comparisons, and crash-receipt recovery;
  - install now switches from any live AIM descriptor and directly replaces native auth while retaining one passive deterministic backup;
  - uninstall restores that backup only when the live entry is AIM-managed; native/foreign live auth is left untouched without error;
  - stale legacy receipt fields are deleted and status derives installed/binding directly from live auth.
- `src/cli/commands/harness-target.js`
  - stopped persisting selection/uninstall receipts;
  - reads current labels from live auth;
  - prebuilds selected descriptors before provider mutations and writes local cleanup once.
- `src/cli/args.js`, `src/cli/help.js`, `README.md`
  - removed the `--replace-native-auth` gate and documented direct selection semantics.
- `src/cli/commands/claude.js`
  - removed the post-run full-target write that could roll unrelated Prime state backward.

Verification:

- Exact reported regression: stale Anthropic `pro8` receipt plus live AIM `pro7` no longer blocks `aim prime run codex`; Codex launches and native Anthropic auth is restored.
- Legacy `pendingTransition` / `lastInstalledDescriptor` fields are ignored and cleaned.
- Live status now reports Anthropic `pro7` as installed directly from `auth.json`, with no ownership-conflict or pending-transition fields.
- `npm test` — 358/358 passed.
- `npm run lint` — passed.

No live auth, backup, or local target state was mutated during verification; the live status check was read-only.
