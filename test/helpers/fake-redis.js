export class FakeRedisClient {
  constructor() {
    this.values = new Map();
    this.sets = new Map();
    this.isOpen = true;
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, value);
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
    return keys.map((key) => this.values.get(key) ?? null);
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
