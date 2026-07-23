export class FakeRedisClient {
  constructor({ nowMs = 0 } = {}) {
    this.values = new Map();
    this.sets = new Map();
    this.expirations = new Map();
    this.isOpen = true;
    this.nowMs = nowMs;
  }

  advanceTime(milliseconds) {
    this.nowMs += milliseconds;
  }

  expireIfNeeded(key) {
    const expiresAt = this.expirations.get(key);
    if (expiresAt !== undefined && expiresAt <= this.nowMs) {
      this.values.delete(key);
      this.expirations.delete(key);
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
      if (this.values.delete(key)) deleted += 1;
      if (this.sets.delete(key)) deleted += 1;
      this.expirations.delete(key);
    }
    return deleted;
  }

  async eval(script, { keys = [], arguments: args = [] } = {}) {
    const [key, targetKey] = keys;
    this.expireIfNeeded(key);
    if (script.includes("AIMGR_CREDENTIAL_LEASE_RENEW_V1")) {
      if (this.values.get(key) !== args[0]) return 0;
      this.expirations.set(key, this.nowMs + Number(args[1]));
      return 1;
    }
    if (script.includes("AIMGR_CREDENTIAL_LEASE_RELEASE_V1")) {
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

  async watch() {
    return "OK";
  }

  async unwatch() {
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
