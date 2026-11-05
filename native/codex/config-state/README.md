# AIM's finite Codex configuration and database helper

This is an AIM executable linked to the unchanged upstream libraries identified
in `source.json`. It is paired with the official package by the runtime's
content-addressed approval manifest. It does not replace or modify Codex.

Build only on the isolated development hosts. Download the exact official
release source archive; `prepare-source.py` verifies its recorded digest:

```sh
curl --fail --location https://github.com/openai/codex/archive/refs/tags/rust-v0.166.0.tar.gz -o codex-source.tar.gz
python3 prepare-source.py codex-source.tar.gz
cargo build --locked --release -j 1
```

The Rust toolchain, source archive, dependency lock and upstream patches are
pinned. `vendor/` and `target/` are build inputs/outputs, never committed or
included in account-state transfer. Linux builds need the platform's C compiler,
pkg-config, OpenSSL development headers and the upstream native dependencies.
macOS builds use the platform SDK. The final installer hashes the built helper
alongside the unchanged official vendor executables.

The approved pair is official Codex 0.166.0 and its release commit
`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. A source checkout's embedded
development version is not release provenance; pair by the release tag/commit
and published binary digests. Native acceptance is rerun when this pair changes.

The package also builds `aimgr-codex-worktree`, a separate finite executable for
the explicitly requested Git checkout operation and native ownership binding.
It calls unchanged `WorktreeManager` APIs under ordinary tool semantics. It
does not load configuration, auth, models or telemetry. Keeping it separate
preserves the configuration/state executable's unconditional process-exec
denial. The final runtime manifest admits both binaries together.

The request arrives on a dedicated private pipe. `inputs` loads the effective
local configuration under OS-enforced outbound/exec denial. The loader
performs reads normally; AIM adds no filesystem-integrity sandbox to it. `initialize` uses the same loader, checks mandatory privacy settings,
then opens the native databases under short locks on their actual shared roots.
It closes the native pools before releasing the locks; native migrations remain
the readiness authority, without a separate completion cache. No model, auth,
remote policy, MCP, exporter or long-running
server is started. The output is a finite inventory of paths and policy facts;
configuration contents, credential values and native error details are omitted.

The Mac parent must supply captured forced MDM strings, including explicit
empty strings when absent. Local hostname-based remote sandbox requirements
are rejected by AIM before the helper starts. Organization-owned remote policy
remains the user-approved gap; the helper does not simulate or intercept it.

Implementation acceptance is recorded in the canonical privacy plan and worklog.
A successful build alone does not approve this helper or the official package.
