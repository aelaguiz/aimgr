# aimgr

AI account manager for people running **multiple paid AI accounts** across multiple tools (OpenClaw / Codex CLI / Claude CLI).

## Non-negotiables (v0)

- **No guessing / no black boxes**: adapters are written from upstream source behavior (OpenClaw/Codex/Claude), not vibes.
- **aimgr is the SSOT** for credentials + mappings. Downstream tool stores are **derived outputs** and may be overwritten.
- **Plaintext secrets on disk**: no Keychain, no encryption, no secret manager. Just a flat file.
- **No `*:default` for managed accounts** (especially `openai-codex:default`) in steady state.

## Quick start (sandboxed)

This is designed to run against a sandboxed HOME so you can test without touching real `~/.openclaw`.

Example:

```bash
./bin/aimgr.js status --home ~/workspace/agents/work/aimgr/sandbox/home
./bin/aimgr.js adopt openclaw --home ~/workspace/agents/work/aimgr/sandbox/home --write
./bin/aimgr.js status --home ~/workspace/agents/work/aimgr/sandbox/home
```

## Commands

- `aimgr status` — read-only health + drift report
- `aimgr adopt openclaw` — import OpenClaw OAuth profiles into aimgr (SSOT)
- `aimgr sync openclaw` — rewrite OpenClaw auth stores from aimgr (no `*:default`)

