# Redis Cloud migration — October 20, 2026

AIM now uses Redis Cloud Essentials: database `aimgr` (`14706401`), subscription `3456375`, AWS Ohio, 250 MB, $5/month. Endpoint: `measure-permissible-test-42143.db.redis.io:12453`. TLS and password authentication are enabled; replicas, persistence, and remote backups are off. The eviction policy is `noeviction`.

The authenticated `rediss://` URL lives in each host’s private `~/.aimgr/config.yaml`. Keep DB 0 and `aimgr:v1:`. The system trust store validates the service certificate; no custom CA is needed. Never commit the password-bearing URL.

**Migrated hosts**

M5, home, Mac Studio, M3 Max, and M3 36 GB all passed direct TLS connection and credential-read checks. Their installed `aim redis ping` commands returned `PONG`. Fly connectivity was verified from the existing `ps-agents-db-mcp` machine without changing that app. The old M1 (`amirs-old-m1`) remains offline; configure it when reachable.

The M3 Max’s old `/opt/homebrew/bin/aim` symlink now points to its current `~/.local/bin/aim` wrapper. The M3 36 GB installation received its missing dependencies using its existing lockfile. Redis YAML updates preserved the other host settings.

**Data and running sessions**

The source was write-paused for the in-memory copy. All 94 AIM-prefix keys compared successfully, including 63 credential records and 23 live account leases. Live lease owners were preserved for the handoff; all 23 subsequently renewed with normal TTLs. No backup file was created. The existing credential-index discrepancy remains: 64 index entries, 63 actual records, with the Sakana record absent before migration.

The old `aimgr-redis` Docker container and `aimgr-redis-data` volume were removed. The 22 other running Colima containers were preserved. Redis Cloud is the only writable database.

Existing processes retain the old Redis URL in memory. A temporary native macOS relay on the Studio forwards those old connections to Redis Cloud, preserving one upstream connection per client. New AIM processes use direct TLS. No user session or Prime daemon was deliberately stopped or resumed, and no account rotation was performed.

**Temporary relay**

- LaunchAgent: `com.aimgr.redis-migration-relay`, Studio user `agents`, UID 502.
- Listener: `127.0.0.1:6380`, behind the existing Redis-only Tailscale Serve mapping.
- Script and private connection file: `/Users/agents/.aimgr/runtime/redis-migration/`.
- Retirement marker: `armed` in that directory; automatic retirement is enabled.
- Status: `/Users/agents/.aimgr/logs/redis-migration-relay-status.json`.
- Log: `/Users/agents/.aimgr/logs/redis-migration-relay.log`.

When there are zero connections for two minutes, the relay removes the TCP 6380 Tailscale Serve mapping, its LaunchAgent, and its private runtime files, then exits. Other Tailscale services remain. Until status becomes `retired`, pre-migration processes still depend on the Studio and Tailscale. Do not stop the relay with active connections.

```bash
ssh amirs-mac-studio 'cat ~/.aimgr/logs/redis-migration-relay-status.json'
```

**Verification**

Real-service tests passed for compare-and-swap, conflicting WATCH transactions, lease contention, Lua renewal/release, and reconnect after server-side termination of a disposable connection. The same operations passed through the relay. Fourteen config/Redis CLI tests passed; eleven earlier focused redaction/status tests also passed. Temporary test keys were removed.

AIM MCP launches a fresh AIM subprocess for each request, so it reads the new config without a daemon restart. The M3 Max auth-maintainer plist points to the updated checkout; its disabled/unloaded state was preserved.

The full plan and execution record is saved on the M5 Desktop as `AI_Manager_Redis_Migration_Plan_2026-10-20.md`. No recurring maintenance, monitoring, or backup jobs were added.
