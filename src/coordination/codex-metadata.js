import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { normalizeLabel } from "../core/normalize.js";

// Projection happens inside Redis. Fetching a legacy credential record and
// deleting its tokens in Node would already have transferred a foreign grant.
const READ_METADATA = `
-- AIMGR_CODEX_METADATA_READ_V1
local keys=redis.call('SMEMBERS',KEYS[1])
local out={}
for _,key in ipairs(keys) do
  local raw=redis.call('GET',key)
  if raw then
    local item=cjson.decode(raw)
    if item.provider~=ARGV[2] or type(item.label)~='string' or key~=ARGV[1]..item.label then
      return redis.error_reply('invalid Codex metadata index')
    end
    local policy=item.policy or {}
    local identity=item.identity or {}
    table.insert(out,{label=item.label,accountId=identity.accountId,version=item.version,
      policy={egress=policy.egress,expect=policy.expect,browser=policy.browser,pool=policy.pool}})
  end
end
return cjson.encode(out)
`;

export async function readCodexAccountMetadata(store) {
  let result;
  try {
    result = JSON.parse(await store.client.eval(READ_METADATA, {
      keys: [store.keys.credentialsByProvider(OPENAI_CODEX_PROVIDER)],
      arguments: [store.keys.credential({ provider: OPENAI_CODEX_PROVIDER, label: "" }), OPENAI_CODEX_PROVIDER],
    }));
  } catch { throw new Error("Codex account metadata could not be read safely."); }
  // Redis cjson encodes an empty Lua table as an object.
  if (!Array.isArray(result)) {
    if (result && Object.keys(result).length === 0) return [];
    throw new Error("Codex account metadata has an invalid shape.");
  }
  return result.map(item => ({ ...item, label: normalizeLabel(item.label) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// A new local authorization may create the label's metadata, but must not
// rewrite an existing legacy grant even when the underlying account matches.
const CREATE_METADATA = `
-- AIMGR_CODEX_METADATA_CREATE_V1
local raw=redis.call('GET',KEYS[1])
if raw then
  local current=cjson.decode(raw)
  if current.provider~=ARGV[2] or current.label~=ARGV[3] or not current.identity or current.identity.accountId~=ARGV[4] then
    return 'identity_conflict'
  end
  if ARGV[5]~='' then
    local expected=cjson.decode(ARGV[5])
    local assigned=(current.policy or {}).egress
    if expected==cjson.null then
      if assigned~=nil then return 'assignment_conflict' end
    elseif type(assigned)~='table' or assigned.profileRef~=expected.profileRef then
      return 'assignment_conflict'
    end
  end
  return 'unchanged'
end
redis.call('SET',KEYS[1],ARGV[1])
redis.call('SADD',KEYS[2],KEYS[1])
redis.call('SADD',KEYS[3],KEYS[1])
return 'created'
`;

export async function ensureCodexAccountMetadata(store, { label, accountId, egress, expectedEgress, now = new Date().toISOString() }) {
  label = normalizeLabel(label);
  if (typeof accountId !== "string" || !accountId.trim()) throw new Error("Codex metadata requires an account identity.");
  const record = { kind: "aimgr.credential.v1", provider: OPENAI_CODEX_PROVIDER, label,
    credential: {}, identity: { accountId }, policy: { pool: { enabled: true }, ...(egress ? { egress } : {}) },
    health: { status: "candidate", reason: "credential_missing" }, provenance: {},
    createdAt: now, updatedAt: now, updatedBy: "aimgr-codex-local", version: 1 };
  let outcome;
  try {
    outcome = await store.client.eval(CREATE_METADATA, {
      keys: [store.keys.credential({ provider: OPENAI_CODEX_PROVIDER, label }), store.keys.credentials(), store.keys.credentialsByProvider(OPENAI_CODEX_PROVIDER)],
      arguments: [JSON.stringify(record), OPENAI_CODEX_PROVIDER, label, accountId,
        expectedEgress === undefined ? "" : JSON.stringify(expectedEgress)],
    });
  } catch { throw new Error("Codex account metadata could not be registered safely."); }
  if (outcome === "assignment_conflict") throw new Error("This Codex account's proxy assignment changed during login. Retry using its current assignment.");
  if (!["created", "unchanged"].includes(outcome)) throw new Error("This Codex label belongs to a different or unverified account identity.");
  return { outcome };
}

// Mutate only account routing metadata inside Redis. The legacy primary grant
// is neither returned to this environment nor rewritten by the client.
const SET_EGRESS = `
-- AIMGR_CODEX_METADATA_EGRESS_V1
local raw=redis.call('GET',KEYS[1])
if not raw then return 'missing' end
local current=cjson.decode(raw)
if current.provider~=ARGV[1] or current.label~=ARGV[2] or not current.identity or current.identity.accountId~=ARGV[3] then
  return 'identity_conflict'
end
if current.version~=tonumber(ARGV[4]) then return 'version_conflict' end
current.policy=current.policy or {}
current.policy.egress=cjson.decode(ARGV[5])
current.version=current.version+1
current.updatedAt=ARGV[6]
current.updatedBy='aimgr-codex-proxy'
redis.call('SET',KEYS[1],cjson.encode(current))
return 'updated'
`;

export async function setCodexAccountEgress(store, { label, accountId, expectedVersion, egress, now = new Date().toISOString() }) {
  label = normalizeLabel(label);
  if (!accountId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("Codex proxy assignment needs current account metadata.");
  const outcome = await store.client.eval(SET_EGRESS, {
    keys: [store.keys.credential({ provider: OPENAI_CODEX_PROVIDER, label })],
    arguments: [OPENAI_CODEX_PROVIDER, label, accountId, String(expectedVersion), JSON.stringify(egress), now],
  });
  if (outcome !== "updated") throw new Error(`Codex ${label}: account identity or proxy assignment changed; reload and retry.`);
  return { version: expectedVersion + 1 };
}
