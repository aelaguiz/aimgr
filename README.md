# aimgr

AI account manager for people running **multiple paid AI accounts** across multiple tools (OpenClaw / Codex CLI / Claude CLI).

## Non-negotiables (v0)

- **No guessing / no black boxes**: adapters are written from upstream source behavior (OpenClaw/Codex/Claude), not vibes.
- **aimgr is the SSOT** for credentials + mappings. Downstream tool stores are **derived outputs** and may be overwritten.
- **Plaintext secrets on disk**: no Keychain, no encryption, no secret manager. Just a flat file.
- **No `*:default` for managed accounts** (especially `openai-codex:default`) in steady state.

## Command shape (label-only)

You should only ever need to remember the account **label** (`boss`, `coder2`, …):

```bash
aim status
aim boss     # login/refresh + auto-pin agent_boss -> boss + apply to OpenClaw
aim coder2   # login/refresh + auto-pin agent_coder2 -> coder2 + apply to OpenClaw

# Rare: manual override / non-standard mapping
aim pin agent_lessons boss
```

## SSOT file (one file; plaintext; local-only)

`aim` reads and writes a single file:

- `~/.aimgr/secrets.json`
  - accounts (label → provider + OpenClaw browser profile)
  - pins (OpenClaw agent → label)
  - credentials (provider + label → OAuth tokens + expiry + accountId)

Every write creates an automatic timestamped backup sibling file first:

- `~/.aimgr/secrets.json.bak.<timestamp>`

## Advanced: alternate HOME (dev/test only)

Normal operation is **live** (writes to `~/.aimgr/` and `~/.openclaw/` with backup-on-write).

For development/tests, you can point `aim` at an alternate HOME via `--home` so you don’t touch real state:

```bash
aim status --home /tmp/aimgr-home
aim apply  --home /tmp/aimgr-home
```

Note: `aim login <label>` opens Chrome and performs OAuth; it must run on macOS with a real browser (localhost callback).
OAuth runs inside the selected OpenClaw browser profile (Chrome `--user-data-dir` under `~/.openclaw/browser/**/user-data`).
