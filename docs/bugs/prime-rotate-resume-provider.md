---
title: Prime rotating resume must preserve the source session provider and model
date: 2026-08-09
status: resolved
owners: [aimgr]
reviewers: []
related: []
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** `aim prime resume <session> --rotate` always launches Codex, even when the source session last used Claude Fable.
- **Impact:** rotating a Claude session silently changes its provider/model and selects the wrong account pool.
- **Most likely cause:** `handleResume` hard-codes Codex selection, `openai-codex`, and `gpt-5.6-sol`.
- **Next action:** none; the provider-aware rotation path is implemented and verified.
- **Status:** resolved

<!-- bugs:block:analysis -->
## Bug North Star

A rotating resume changes only the managed account binding; it preserves the source session's last-used provider and exact model.

## Bug summary

The reported source session `019fe427-6965-7082-b0cc-f9a8be09bcb8` records `anthropic` / `claude-fable-5` and binding `pro8`, but AIM prints `openai-codex · pro1 · rotating resume`.

## Evidence

- `src/cli/commands/harness-target.js` currently calls `handleUse` with `codex: "auto"` and launches with hard-coded `--provider openai-codex --model gpt-5.6-sol`.
- The reported JSONL begins with a `model_change` for `anthropic` / `claude-fable-5` and contains an AIM `credential_binding` for `anthropic` / `pro8`.
- Its latest assistant messages also record `anthropic` / `claude-fable-5`.

## Investigation

The rotate path never reads the source session. Claude account selection also has no way to exclude the source binding, so changing only the final launch flags would not implement rotation correctly.

## Scope and simplicity contract

- **Human-authorized corrected behavior:** rotate a resumed Prime session within whatever provider it last used, preserving its exact model.
- **Smallest sufficient fix:** inspect source JSONL metadata; choose another managed account from that provider; pass the source provider/model and reset only that provider's binding in the fork.
- **Initial minimal convergence closure:** extend the existing Claude selection helper to exclude a current binding, matching the Codex rotate contract. No other callers or commands compete for this contract.
- **Scope freeze:** frozen before implementation.
- **Enough proof:** focused Codex and Claude rotate tests assert selected provider, account, model, and launcher args.
- **Do not build:** no new CLI syntax, provider override, generic session catalog, or compatibility fallback.
- **Accepted residual risk:** rotating resume supports the two AIM-managed providers only and fails loudly for unsupported/missing source metadata.

<!-- bugs:block:fix_plan -->
## Fix plan

1. Resolve a path/full session ID in Prime's configured session directory and read the last-used assistant/model metadata plus provider binding.
2. Route rotation through the existing provider-specific account selectors while excluding the source binding.
3. Launch the fork with the recorded exact provider/model and reset that provider binding.
4. Add focused regression coverage.

<!-- bugs:block:implementation -->
## Implementation and verification

Implemented in `src/cli/commands/harness-target.js`:

- rotating resume resolves the source path/full or partial ID from Prime's configured session directory;
- it reads the last recorded model/provider and AIM binding from the JSONL;
- Codex and Claude selection both exclude the source binding;
- the fork receives the recorded exact provider/model and resets only that provider binding.

Proof:

- `node --test test/pi/prime-target.test.js` — 15/15 passed, including provider/model preservation for Codex and Claude Fable plus no-alternate refusal.
- `npm test` — 360/360 passed.
- `npm run lint` — passed.
