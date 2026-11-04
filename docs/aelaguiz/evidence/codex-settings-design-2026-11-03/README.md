# Codex shared-settings design evidence — November 3, 2026

Two local synthetic checks support the settings adapter in [the Codex privacy plan](../../CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md#43-account-state-and-configuration-origins). They use invented settings and temporary files. Neither invokes Codex nor reads real settings or credentials.

| Check | Observed result | Limit |
| --- | --- | --- |
| [TOML projection](projection-proof.mjs) with `toml-eslint-parser@1.0.3`, TOML 1.0 mode | Passed path-literal projection, relative-path restoration after simulated skill/model edits, distinct profile origins, inline/array tables, unknown-key preservation and invalid/empty input checks. | Tests a subset of the typed path manifest. No native loader comparison, full merge implementation, home expansion, permission or crash certification. |
| [Atomic file exchange](exchange-proof.py) on Darwin | Passed replacement while retaining a racing writer's version, and retained a subsequent write through an already-open descriptor to the displaced inode. | Proves the local OS primitive, not a durable transaction journal. Linux code is included but was not run. |

The source review uses official Codex commit `54201ea65a3501d09a87c776376a0c16aa39db70`. Native per-file path conversion occurs in `codex-rs/config/src/loader/mod.rs::resolve_relative_paths_in_config_toml`; native settings edits resolve symlinks in `codex-rs/core/src/config/edit.rs`. The parser's [official API documentation](https://ota-meshi.github.io/toml-eslint-parser/) exposes syntax-tree ranges, enabling narrow edits without rewriting unrelated TOML.

These checks establish that the proposed representation and the Mac exchange primitive are usable. They do not certify the full settings adapter or private-home launch. The plan's P09a–h matrix supplies the required native and failure tests.

Reproduce with a disposable parser installation outside the repository:

```bash
proof_deps="$(mktemp -d /tmp/aimgr-codex-settings-proof.XXXXXX)"
npm install --prefix "$proof_deps" --ignore-scripts --no-audit --no-fund toml-eslint-parser@1.0.3
node docs/aelaguiz/evidence/codex-settings-design-2026-11-03/projection-proof.mjs "$proof_deps/node_modules/toml-eslint-parser/lib/index.mjs"
python3 docs/aelaguiz/evidence/codex-settings-design-2026-11-03/exchange-proof.py
```

The scripts print named results and scope limits. Remove the disposable dependency directory after use. No repository dependency or production implementation is added by these proofs.
