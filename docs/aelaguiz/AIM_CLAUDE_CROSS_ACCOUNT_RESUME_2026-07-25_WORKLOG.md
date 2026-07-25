# AIM Claude cross-account resume worklog

Plan:
[AIM_CLAUDE_CROSS_ACCOUNT_RESUME_2026-07-25.md](./AIM_CLAUDE_CROSS_ACCOUNT_RESUME_2026-07-25.md)

## 2026-07-25

- Start and plan modes completed docs-only.
- Scope froze at busy-only automatic Opus fallback, native fork/name,
  temporary transcript staging, focused proof, and fleet deployment.
- Pre-implementation behavior proof passed twice: first with the real Claude
  binary against a contained local endpoint, then through real AIM/OAuth from
  `pro10` to `pro11`. Both produced a distinct thread, persisted provenance,
  loaded inherited context, and preserved the source transcript.
- Finish mode started. No shared session store, new CLI option, lease bypass,
  retry engine, migration, daemon, or cross-machine session transfer is
  authorized.
- Implemented the busy-only branch, shared automatic-selection helper,
  deterministic provenance name, stable transcript staging, private staging
  marker, and lifecycle cleanup.
- Focused session tests passed 4/4; focused Redis projection/command tests
  passed 22/22; lint and `git diff --check` passed.
- Full repository suite passed 369/369.
- Live implemented-command proof: `aim claude resume
  fcb28534-a7d5-4774-8546-2d9f64ae4ec6` observed busy source `pro10`, selected
  unlocked `pro11`, loaded the inherited session in the real Claude TUI, and
  persisted fork `92ae17a3-54fe-4d2f-9448-fad2dd8bc518` as
  `[fork from pro10/fcb28534] Review puzzle quality for The Fish Fights Back`.
  The source SHA-256 remained
  `0c7696c2ba9651b48eecec3d5be8e6c5e4dc303f0f263f5850031b695d9b0f5f`;
  the staged source and marker were absent after exit; the fork remained
  listed under `pro11`; and `pro11` returned to unlocked `usage_readable`.
