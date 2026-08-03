# AIM Claude Redis Authority Simplification — Worklog

## 2026-08-03 — Scope freeze

- Froze the paired mini-architecture plan before editing production code.
- Reproduced the motivating failure: `pro11` local credential is the proven predecessor of Redis v33, but a stale v31 projection receipt turns that valid state into a launch blocker.
- Confirmed the retained safety mechanisms already exist independently of receipts/fences: the per-account Redis lease, exact identity checks, expected-version CAS, and strictly-newer credential publication.
- Explicitly excluded daemons, migrations, new state, new frameworks, Codex changes, ranking changes, and unrelated Claude UX.

## Implementation

- Deleted the durable Claude rotation-fence module and every runtime reader/writer.
- Removed projection receipts from launch authority and opportunistically deletes legacy receipt maps on the next local-state write.
- Online launch now publishes only a strictly newer same-identity local candidate; otherwise Redis overwrites the disposable local cache, including malformed or different local app state.
- Login keeps isolated staging but holds and renews the existing per-label lease across the browser flow, then identity-validates and CAS-publishes once.
- Status, JSON status, and automatic selection now share Redis credential + lease facts; ordinary expired access tokens remain launchable when a refresh lineage exists.
- Future credential writes strip legacy fence provenance. Existing Redis fence keys are inert and unread.

## Verification

- Focused projection/login/maintenance/status proof: 79/79 PASS.
- Full repository suite: 304/304 PASS.
- `npm run lint`: PASS.
- `git diff --check`: PASS.
- Static old-path scan: no runtime fence module, fence state, local-projection status, or old user-blocking conflict text remains.
- Exact regression: valid legacy receipt at credential v1 + local predecessor v2 + Redis canonical v3 launches once, projects v3, leaves Redis v3, and deletes the legacy receipt.
- Disposable-cache regressions: incomplete credentials, malformed app state, and a different local app-state identity are overwritten from Redis.
- Installed the working tree with `npm run install:local`; `aim claude run pro11 -- --version` returned `2.1.220 (Claude Code)` with no model invocation.
- After the live proof, `pro11` remained `READY`, its Redis inventory was `usage_readable`, and `~/.aimgr/local-state.json` had no projection-receipt map.

## Deployment

- Local canonical AIM installation: PASS.
- Implementation commit `2d9fe9e` pushed to `origin/main`.
- Fast-forwarded and installed the implementation on `amirs-m3-max-new`, `agents@amirs-mac-studio`, `home`, and `claw`; Amir-M5 is the verified local canonical installation.
- Verified every checkout at `2d9fe9e` and every installed wrapper with `aim --help` (using the absolute wrapper path where noninteractive SSH omitted user PATH entries).
- Preserved pre-existing untracked files on the Mac Studio, home, and claw checkouts; local `.antigravitycli/` and `.tmp/` were also untouched.
