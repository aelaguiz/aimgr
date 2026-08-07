export class FakeRedisClient {
  constructor({ nowMs = 0 } = {}) {
    this.values = new Map();
    this.sets = new Map();
    this.expirations = new Map();
    this.isOpen = true;
    this.nowMs = nowMs;
    // WATCH/MULTI fidelity: every mutation (including expiry) bumps a per-key
    // version so a fenced EXEC observes concurrent writes and key expiry the
    // same way a real Redis server would.
    this.keyVersions = new Map();
    this.watchedVersions = null;
  }

  advanceTime(milliseconds) {
    this.nowMs += milliseconds;
  }

  bumpKeyVersion(key) {
    this.keyVersions.set(key, (this.keyVersions.get(key) ?? 0) + 1);
  }

  expireIfNeeded(key) {
    const expiresAt = this.expirations.get(key);
    if (expiresAt !== undefined && expiresAt <= this.nowMs) {
      this.values.delete(key);
      this.expirations.delete(key);
      this.bumpKeyVersion(key);
    }
  }

  async get(key) {
    this.expireIfNeeded(key);
    return this.values.get(key) ?? null;
  }

  async set(key, value, options = {}) {
    this.expireIfNeeded(key);
    const condition = options.condition ?? (options.NX ? "NX" : options.XX ? "XX" : null);
    if (condition === "NX" && this.values.has(key)) return null;
    if (condition === "XX" && !this.values.has(key)) return null;
    this.values.set(key, value);
    this.bumpKeyVersion(key);
    const expiration = options.expiration;
    const px = expiration?.type === "PX" ? expiration.value : options.PX;
    if (Number.isFinite(px)) {
      this.expirations.set(key, this.nowMs + px);
    } else {
      this.expirations.delete(key);
    }
    return "OK";
  }

  async sAdd(key, member) {
    const set = this.sets.get(key) ?? new Set();
    const had = set.has(member);
    set.add(member);
    this.sets.set(key, set);
    return had ? 0 : 1;
  }

  async sMembers(key) {
    return [...(this.sets.get(key) ?? new Set())];
  }

  async mGet(keys) {
    return Promise.all(keys.map((key) => this.get(key)));
  }

  async del(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    for (const key of list) {
      const removedValue = this.values.delete(key);
      const removedSet = this.sets.delete(key);
      if (removedValue) deleted += 1;
      if (removedSet) deleted += 1;
      if (removedValue || removedSet) this.bumpKeyVersion(key);
      this.expirations.delete(key);
    }
    return deleted;
  }

  async eval(script, { keys = [], arguments: args = [] } = {}) {
    const [key, targetKey] = keys;
    this.expireIfNeeded(key);
    // Real Redis reports script SET/PEXPIRE/DEL touches of a WATCHed key as
    // modifications, so every mutating script branch bumps the key version.
    if (script.includes("AIMGR_CREDENTIAL_LEASE_RENEW_OR_REACQUIRE_V1")) {
      const owner = this.values.get(key);
      if (owner !== undefined && owner !== args[0]) return 0;
      this.values.set(key, args[0]);
      this.expirations.set(key, this.nowMs + Number(args[1]));
      this.bumpKeyVersion(key);
      return 1;
    }
    if (script.includes("AIMGR_CREDENTIAL_LEASE_RENEW_V1")) {
      if (this.values.get(key) !== args[0]) return 0;
      this.expirations.set(key, this.nowMs + Number(args[1]));
      this.bumpKeyVersion(key);
      return 1;
    }
    if (script.includes("AIMGR_CREDENTIAL_LEASE_RELEASE_V1")) {
      if (this.values.get(key) !== args[0]) return 0;
      return this.del(key);
    }
    if (script.includes("AIMGR_CODEX_IDENTITY_CATALOG_LEASE_RENEW_V1")) {
      if (this.values.get(key) !== args[0]) return 0;
      this.expirations.set(key, this.nowMs + Number(args[1]));
      this.bumpKeyVersion(key);
      return 1;
    }
    if (script.includes("AIMGR_CODEX_IDENTITY_CATALOG_LEASE_RELEASE_V1")) {
      if (this.values.get(key) !== args[0]) return 0;
      return this.del(key);
    }
    if (script.includes("AIMGR_CREDENTIAL_LEASE_GUARDED_DELETE_V1")) {
      this.expireIfNeeded(targetKey);
      if (this.values.get(key) !== args[0]) return 0;
      if (this.values.get(targetKey) !== args[1]) return -1;
      return this.del(targetKey);
    }
    throw new Error("Unsupported fake Redis script.");
  }

  async watch(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    if (this.watchedVersions === null) this.watchedVersions = new Map();
    for (const key of list) {
      this.expireIfNeeded(key);
      this.watchedVersions.set(key, this.keyVersions.get(key) ?? 0);
    }
    return "OK";
  }

  async unwatch() {
    this.watchedVersions = null;
    return "OK";
  }

  multi() {
    const ops = [];
    const client = this;
    const tx = {
      set(key, value) {
        ops.push(["set", key, value]);
        return tx;
      },
      sAdd(key, member) {
        ops.push(["sAdd", key, member]);
        return tx;
      },
      async exec() {
        const watched = client.watchedVersions;
        client.watchedVersions = null;
        if (watched) {
          for (const [key, version] of watched) {
            client.expireIfNeeded(key);
            if ((client.keyVersions.get(key) ?? 0) !== version) {
              // Real Redis aborts the transaction when any watched key changed.
              return null;
            }
          }
        }
        const results = [];
        for (const [op, key, value] of ops) {
          results.push(op === "set" ? await client.set(key, value) : await client.sAdd(key, value));
        }
        return results;
      },
    };
    return tx;
  }
}
