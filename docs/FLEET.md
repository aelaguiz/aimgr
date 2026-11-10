# AI Manager fleet

The fleet consists of these seven machines:

| Machine | SSH target |
|---|---|
| M5 | `amir-m5` |
| Home server | `home` |
| Mini 1 | `amir-mini-1` |
| Mini 2 | `amir-mini-2` |
| Mac Studio | `amirs-mac-studio` (user `agents`) |
| M3 Max | `amirs-m3-max-new` |
| M3 36 GB | `amir-m3-36gb` |

Each machine installs AI Manager itself from its own `~/workspace/aimgr` checkout with
`scripts/install-release.sh`; devcluster runs it whenever that checkout moves (README,
"Installing on a machine"). `scripts/sync-fleet.sh` deploys only prime-agent and is not the AIM deployment path.
The M5 uses `~/.local/share/aimgr/checkout` for devcluster; other machines use
`~/workspace/aimgr`. `aim cluster status` uses these machines and their devcluster
SSH targets to show the account status on each.

Amir retired the old M1 from the fleet on October 25, 2026. Its aliases
`amirs-old-m1`, `amir-old-m1` and `old-m1` are not deployment or health-check
targets. Do not probe it, queue updates for it, or report it as a missing fleet
machine. Historical references and saved SSH aliases do not make it active.
