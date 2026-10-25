# AI Manager fleet

The fleet consists of these five machines:

| Machine | SSH target |
|---|---|
| M5 | `amir-m5` |
| Home server | `home` |
| Mac Studio | `amirs-mac-studio` (user `agents`) |
| M3 Max | `amirs-m3-max-new` |
| M3 36 GB | `amir-m3-36gb` |

`scripts/sync-fleet.sh` runs from the M5 and targets the other four machines.

Amir retired the old M1 from the fleet on October 25, 2026. Its aliases
`amirs-old-m1`, `amir-old-m1` and `old-m1` are not deployment or health-check
targets. Do not probe it, queue updates for it, or report it as a missing fleet
machine. Historical references and saved SSH aliases do not make it active.
