import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  AIMGR_CONFIG_VERSION,
  AIMGR_REDIS_DEFAULT_KEY_PREFIX,
  AIMGR_REDIS_PRIMARY_HOST,
  AIMGR_REDIS_PRIMARY_URL,
} from "../core/constants.js";
import { isObject } from "../core/normalize.js";
import { resolveAimgrConfigPath } from "../io/paths.js";

export function normalizeRedisKeyPrefix(value = AIMGR_REDIS_DEFAULT_KEY_PREFIX) {
  const raw = String(value ?? "").trim() || AIMGR_REDIS_DEFAULT_KEY_PREFIX;
  return raw.endsWith(":") ? raw : `${raw}:`;
}

export function normalizeAimgrConfig(raw = {}) {
  const source = isObject(raw) ? raw : {};
  const redis = isObject(source.redis) ? source.redis : {};
  const url = typeof redis.url === "string" && redis.url.trim() ? redis.url.trim() : null;
  const keyPrefix = normalizeRedisKeyPrefix(redis.keyPrefix);
  const primaryHost =
    typeof redis.primaryHost === "string" && redis.primaryHost.trim()
      ? redis.primaryHost.trim()
      : null;
  const transport =
    typeof redis.transport === "string" && redis.transport.trim()
      ? redis.transport.trim()
      : null;
  return {
    version: Number.isInteger(source.version) ? source.version : AIMGR_CONFIG_VERSION,
    redis: {
      url,
      keyPrefix,
      primaryHost,
      transport,
    },
  };
}

export function readAimgrConfig({ homeDir }) {
  const configPath = resolveAimgrConfigPath({ homeDir });
  if (!fs.existsSync(configPath)) {
    return {
      path: configPath,
      exists: false,
      config: normalizeAimgrConfig(),
    };
  }
  let parsed;
  try {
    parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse AIM config: ${configPath} (${String(err?.message ?? err)})`);
  }
  return {
    path: configPath,
    exists: true,
    config: normalizeAimgrConfig(parsed),
  };
}

export function writeAimgrConfig({ homeDir, config }) {
  const configPath = resolveAimgrConfigPath({ homeDir });
  const normalized = normalizeAimgrConfig(config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, YAML.stringify(normalized), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  return { path: configPath, config: normalized };
}

export function getRedisConfig({ homeDir, requireConfigured = true }) {
  const read = readAimgrConfig({ homeDir });
  const redis = read.config.redis;
  if (requireConfigured && !redis.url) {
    throw new Error(
      `AIM is not attached to Redis. Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`,
    );
  }
  return { ...read, redis };
}
