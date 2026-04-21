import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function mkTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-test-"));
  return dir;
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function writeAimBrowserLocalState(home, label, profileInfo = {}) {
  writeJson(path.join(home, ".aimgr", "browser", label, "user-data", "Local State"), {
    profile: {
      info_cache: {
        Default: {
          name: label,
          user_name: "",
          gaia_name: "",
          ...profileInfo,
        },
      },
    },
  });
}

export function writeChromeLocalState(home, profiles = []) {
  const userDataDir = path.join(home, "Library", "Application Support", "Google", "Chrome");
  const infoCache = {};
  for (const profile of profiles) {
    const profileDirectory = String(profile.profileDirectory ?? "").trim() || "Default";
    fs.mkdirSync(path.join(userDataDir, profileDirectory), { recursive: true });
    infoCache[profileDirectory] = {
      name: profile.name ?? profileDirectory,
      user_name: profile.userName ?? "",
      gaia_name: profile.gaiaName ?? "",
    };
  }
  writeJson(path.join(userDataDir, "Local State"), {
    profile: {
      info_cache: infoCache,
    },
  });
  return userDataDir;
}

export function writeOpenclawBrowserLocalState(home, profileId, profileInfo = {}) {
  writeJson(path.join(home, ".openclaw", "browser", profileId, "user-data", "Local State"), {
    profile: {
      info_cache: {
        Default: {
          name: profileId,
          user_name: "",
          gaia_name: "",
          ...profileInfo,
        },
      },
    },
  });
  return path.join(home, ".openclaw", "browser", profileId, "user-data");
}

export function writeOpenclawAuthStore(home, agentId, data) {
  writeJson(path.join(home, ".openclaw", "agents", agentId, "agent", "auth-profiles.json"), data);
}

export function writeOpenclawSessionsStore(home, agentId, data) {
  writeJson(path.join(home, ".openclaw", "agents", agentId, "sessions", "sessions.json"), data);
}

export async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export function makeFakeJwt(payload = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}
