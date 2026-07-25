# AIM Claude run presets worklog

Plan: [AIM_CLAUDE_RUN_PRESETS_2026-07-24.md](./AIM_CLAUDE_RUN_PRESETS_2026-07-24.md)

## 2026-07-24

- Scope frozen: two fixed parser-level presets, optional resume passthrough,
  existing explicit passthrough preserved, focused proof, and local install.
- Implementation started on `main`; no remote, commit, or push work authorized.
- Phase 1 complete: exact raw-prefix normalization reuses `afterDoubleDash`;
  unknown preset typos fail before Redis; help and README show both forms.
- Focused CLI/Redis/README proof passed: 34 tests, 34 pass.
- Phase 2 complete: lint passed; full suite passed 350/350; diff check passed.
- Local publication complete: `npm run install:local` installed the canonical
  wrappers and installed help shows both the preset and explicit forms.
- Final scope check passed: no remote, fleet, commit, push, runner, credential,
  Redis, rotation, containment, or login changes.
