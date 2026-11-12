# AI Manager fleet

The fleet consists of these ten machines:

| Machine | SSH target |
|---|---|
| M5 | `amir-m5` |
| Home server | `home` |
| Mini 1 | `amir-mini-1` |
| Mini 2 | `amir-mini-2` |
| Mini 3 | `amir-mini-3` |
| Mini 4 | `amir-mini-4` |
| Mac Studio | `amirs-mac-studio` (user `agents`) |
| M3 Max | `amirs-m3-max-new` |
| M3 36 GB | `amir-m3-36gb` |
| Old M1 | `amir-old-m1` |

Each machine installs AI Manager itself from its own `~/workspace/aimgr` checkout with
`scripts/install-release.sh`; devcluster runs it whenever that checkout moves (README,
"Installing on a machine"). `scripts/sync-fleet.sh` deploys only prime-agent and is not the AIM deployment path.
The M5 uses `~/.local/share/aimgr/checkout` for devcluster; other machines use
`~/workspace/aimgr`. `aim cluster status` reads every one of these machines over its devcluster
SSH target and shows one combined table per provider: a row for each account, and a column for
each machine saying whether that machine has its own login.

The old M1 is an active fleet machine (Amir, November 10, 2026: "its literally in active use
right now"). It was set aside on October 25, 2026 and is back; its aliases are `amirs-old-m1`,
`amir-old-m1` and `old-m1`.

Mini 3 (November 10, 2026) and Mini 4 (November 12, 2026) are Mac minis that joined the fleet like Mini 2:
each installs AI Manager from its own checkout and signs every Claude account in through the login gate. Mini 3
ran AI Manager for two days before `aim cluster status` listed it.
