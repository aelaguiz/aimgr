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

test("Codex routine agent and profile survive unrelated config writes", () => {
  const home = mkTempHome();
  const definition = {
    agent: "codex", profile: "automation", calendar: [{ weekday: 1, hour: 7, minute: 0 }],
    cwd: "/tmp/work", promptFile: "/tmp/prompt.md", herdrSession: "growth",
    spaceTitleFormat: "Codex report · {scheduled_local}",
  };
  writeAimgrConfig({ homeDir: home, config: { routines: { report: definition } } });
  const read = readAimgrConfig({ homeDir: home });
  writeAimgrConfig({ homeDir: home, config: { ...read.config, redis: { url: "redis://changed" } } });
  const { routine } = readRoutineDefinition({ homeDir: home, id: "report" });
  assert.equal(routine.agent, "codex");
  assert.equal(routine.profile, "automation");
  assert.equal(routine.model, "gpt-6-astra");
  assert.equal(routine.thinking, "xhigh");
  assert.equal(routine.provider, "openai-codex");
  for (const [overrides, expected] of [
    [{ agent: "unknown" }, /unsupported agent/],
    [{ provider: "anthropic" }, /requires provider=openai-codex/],
    [{ thinking: "off" }, /unsupported thinking/],
    [{ profile: "" }, /requires non-empty profile/],
  ]) {
    writeAimgrConfig({ homeDir: home, config: { routines: { report: { ...definition, ...overrides } } } });
    assert.throws(() => readRoutineDefinition({ homeDir: home, id: "report" }), expected);
  }
});

test("Claude routines preserve their agent, default to Fable xhigh, and reject incompatible settings", () => {
  const home = mkTempHome();
  const definition = { agent: "claude", calendar: [{ hour: 8, minute: 0 }], cwd: "/tmp/work", promptFile: "/tmp/prompt.md",
    herdrSession: "growth", spaceTitleFormat: "Claude report · {scheduled_local}" };
  writeAimgrConfig({ homeDir: home, config: { routines: { report: definition } } });
  const read = readAimgrConfig({ homeDir: home });
  writeAimgrConfig({ homeDir: home, config: { ...read.config, redis: { url: "redis://changed" } } });
  const { routine } = readRoutineDefinition({ homeDir: home, id: "report" });
  assert.equal(routine.agent, "claude");
  assert.equal(routine.provider, "anthropic");
  assert.equal(routine.model, "claude-fable-5-1");
  assert.equal(routine.thinking, "xhigh");
  assert.equal(routine.profile, undefined);
  for (const [overrides, error] of [
    [{ provider: "openai-codex" }, /requires provider=anthropic/],
    [{ profile: "yolo" }, /profile is supported only with agent=codex/],
    [{ thinking: "off" }, /unsupported thinking/],
    [{ thinking: "minimal" }, /unsupported thinking/],
  ]) {
    writeAimgrConfig({ homeDir: home, config: { routines: { report: { ...definition, ...overrides } } } });
    assert.throws(() => readRoutineDefinition({ homeDir: home, id: "report" }), error);
  }
  writeAimgrConfig({ homeDir: home, config: { routines: { report: { ...definition, thinking: "max" } } } });
  assert.equal(readRoutineDefinition({ homeDir: home, id: "report" }).routine.thinking, "max");
});
