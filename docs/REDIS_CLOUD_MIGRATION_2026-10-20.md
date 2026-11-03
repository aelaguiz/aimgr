# Redis Cloud migration — October 20, 2026

AIM uses Redis Cloud Essentials. Configured hosts connect directly with TLS and
password authentication. The authenticated URL belongs in each host's private
`~/.aimgr/config.yaml`, with mode `600`. Keep database 0 and key prefix
`aimgr:v1:`. The system trust store verifies the service certificate; no custom
CA is required. Public documentation uses an example hostname, never the real
password-bearing URL.

The M5, home server, Mac Studio, M3 Max and M3 36 GB passed direct TLS connection
and credential-read checks at migration. The M3 Max's old `aim` symlink was
corrected, and the M3 36 GB received its missing locked dependencies. Existing
host configuration outside the Redis connection was preserved.

The source was write-paused during the in-memory copy. All 94 AIM-prefix keys
compared successfully, including 63 credential records and 23 active leases.
The existing lease owners survived the handoff and renewed normally. The old
Redis container and its volume were removed; unrelated containers remained.
Redis Cloud became the only writable database.

Existing processes retained the old Redis URL in memory. A temporary Mac Studio
relay forwards those connections to Redis Cloud, one upstream connection per
client. New processes connect directly. No user session or Prime daemon was
deliberately stopped or resumed, and no account was rotated for the migration.

The relay's LaunchAgent is `com.aimgr.redis-migration-relay`. Its private runtime
files are in `~/.aimgr/runtime/redis-migration/` on the Studio, and its status is
`~/.aimgr/logs/redis-migration-relay-status.json`. After two minutes with zero
connections, it removes its own Redis Tailscale mapping, LaunchAgent and private
runtime files. Do not stop it while it has active connections. Other Tailscale
services are unaffected.

Migration verification covered compare-and-swap, conflicting WATCH transactions,
lease contention, Lua renewal/release and reconnection after terminating a
disposable connection. The same operations passed through the relay. Temporary
test keys were removed. Config and CLI tests confirmed that status output hides
Redis credentials while the private configuration retains the connection URL.

The original deployment record and connection metadata are retained privately.
No recurring monitoring, backup or maintenance job was introduced by this change.
