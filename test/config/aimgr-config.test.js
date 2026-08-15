import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getRedisConfig,
  normalizeAimgrConfig,
  normalizeRedisKeyPrefix,
  readAimgrConfig,
  writeAimgrConfig,
} from "../../src/config/aimgr-config.js";
import { AIMGR_REDIS_DEFAULT_KEY_PREFIX } from "../../src/core/constants.js";
import { resolveAimgrConfigPath } from "../../src/io/paths.js";
import { readRoutineDefinition } from "../../src/routines/config.js";
import { mkTempHome } from "../helpers/files.js";

test("AIM config defaults to an unattached Redis config", () => {
  const home = mkTempHome();
  const read = readAimgrConfig({ homeDir: home });

  assert.equal(read.exists, false);
  assert.equal(read.path, resolveAimgrConfigPath({ homeDir: home }));
  assert.deepEqual(read.config.redis, {
    url: null,
    keyPrefix: AIMGR_REDIS_DEFAULT_KEY_PREFIX,
    primaryHost: null,
    transport: null,
  });
  assert.throws(() => getRedisConfig({ homeDir: home }), /AIM is not attached to Redis/);
});

test("AIM config normalizes and persists Redis connection details", () => {
  const home = mkTempHome();
  const written = writeAimgrConfig({
    homeDir: home,
    config: {
      redis: {
        url: " redis://amirs-mac-studio:6380 ",
        keyPrefix: "aimgr:test",
        primaryHost: " agents@amirs-mac-studio ",
        transport: " tailscale ",
      },
    },
  });

  assert.equal(written.path, resolveAimgrConfigPath({ homeDir: home }));
  assert.equal(written.config.redis.url, "redis://amirs-mac-studio:6380");
  assert.equal(written.config.redis.keyPrefix, "aimgr:test:");
  assert.equal(written.config.redis.primaryHost, "agents@amirs-mac-studio");
  assert.equal(written.config.redis.transport, "tailscale");

  const mode = fs.statSync(written.path).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.match(fs.readFileSync(written.path, "utf8"), /redis:/);

  const read = getRedisConfig({ homeDir: home });
  assert.equal(read.exists, true);
  assert.equal(read.redis.url, "redis://amirs-mac-studio:6380");
  assert.equal(read.redis.keyPrefix, "aimgr:test:");
});

test("AIM config normalization keeps only the supported shape", () => {
  assert.equal(normalizeRedisKeyPrefix("prefix"), "prefix:");
  assert.equal(normalizeRedisKeyPrefix("prefix:"), "prefix:");

  assert.deepEqual(normalizeAimgrConfig({ version: "old", redis: { url: " ", keyPrefix: "" } }).redis, {
    url: null,
    keyPrefix: AIMGR_REDIS_DEFAULT_KEY_PREFIX,
    primaryHost: null,
    transport: null,
  });
});

test("AIM config parse failures point at the config path", () => {
  const home = mkTempHome();
  const configPath = resolveAimgrConfigPath({ homeDir: home });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "redis: [broken\n", "utf8");

  assert.throws(() => readAimgrConfig({ homeDir: home }), new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("unrelated config writes preserve routine records", () => {
  const home = mkTempHome();
  const routine = {
    calendar: [{ hour: 6, minute: 0 }],
    cwd: "/tmp/work",
    promptFile: "/tmp/prompt.md",
    provider: "anthropic",
    model: "claude-fable-5",
    thinking: "xhigh",
    herdrSession: "growth",
    spaceTitleFormat: "morning report · {scheduled_local}",
  };
  writeAimgrConfig({ homeDir: home, config: { redis: { url: "redis://one" }, routines: { morning: routine } } });
  const current = readAimgrConfig({ homeDir: home }).config;
  writeAimgrConfig({ homeDir: home, config: { ...current, redis: { ...current.redis, url: "redis://two" } } });

  const reread = readAimgrConfig({ homeDir: home }).config;
  assert.deepEqual(reread.routines, { morning: routine });
  assert.equal(reread.redis.url, "redis://two");
});


test("malformed routine records are preserved for strict rejection", () => {
  const home = mkTempHome();
  writeAimgrConfig({ homeDir: home, config: { redis: {}, routines: { broken: "not-an-object" } } });

  assert.equal(readAimgrConfig({ homeDir: home }).config.routines.broken, "not-an-object");
  assert.throws(
    () => readRoutineDefinition({ homeDir: home, id: "broken" }),
    /Routine broken must be an object/,
  );
});
