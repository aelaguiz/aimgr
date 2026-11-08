import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { normalizeLabel } from "../core/normalize.js";

// Execute the allowlist on the server: a legacy bearer must never cross the
// connection just to be deleted in Node. Legacy reauth/health is not local auth.
const READ = `
-- AIMGR_CLAUDE_METADATA_READ_V1
local out={}
for _,key in ipairs(redis.call('SMEMBERS',KEYS[1])) do
 local raw=redis.call('GET',key)
 if raw then
  local item=cjson.decode(raw)
  if item.provider~=ARGV[2] or type(item.label)~='string' or key~=ARGV[1]..item.label then return redis.error_reply('invalid Claude metadata index') end
  local p=item.policy or {}; local i=item.identity or {}
  table.insert(out,{provider=ARGV[2],label=item.label,version=item.version,
   identity={accountUuid=i.accountUuid,emailAddress=i.emailAddress,organizationUuid=i.organizationUuid},
   policy={egress=p.egress,expect=p.expect,browser=p.browser,pool=p.pool}})
 end
end
return cjson.encode(out)`;

export async function readClaudeAccountMetadata(store) {
  let rows;
  try {
    rows = JSON.parse(await store.client.eval(READ, {
      keys: [store.keys.credentialsByProvider(ANTHROPIC_PROVIDER)],
      arguments: [store.keys.credential({ provider: ANTHROPIC_PROVIDER, label: "" }), ANTHROPIC_PROVIDER],
    }));
  } catch { throw new Error("Claude account metadata could not be read safely."); }
  if (!Array.isArray(rows)) {
    if (rows && Object.keys(rows).length === 0) return [];
    throw new Error("Claude account metadata has an invalid shape.");
  }
  return rows.map(row => ({ ...row, label: normalizeLabel(row.label), credential: {}, health: { status: "candidate", reason: "local_login_required" } }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const ENSURE = `
-- AIMGR_CLAUDE_METADATA_ENSURE_V1
local next=cjson.decode(ARGV[1]); local identity=next.identity
for _,key in ipairs(redis.call('SMEMBERS',KEYS[3])) do
 local raw=redis.call('GET',key)
 if raw then
  local item=cjson.decode(raw); local i=item.identity or {}
  if item.label~=next.label and i.accountUuid==identity.accountUuid and i.organizationUuid==identity.organizationUuid then return 'duplicate_identity' end
 end
end
local raw=redis.call('GET',KEYS[1])
if raw then
 local item=cjson.decode(raw); local i=item.identity or {}
 if i.accountUuid and (i.accountUuid~=identity.accountUuid or i.organizationUuid~=identity.organizationUuid) then return 'identity_conflict' end
 local p=item.policy or {}; local expect=p.expect or {}
 if expect.email and string.lower(expect.email)~=string.lower(identity.emailAddress) then return 'identity_conflict' end
 item.identity=identity; item.version=(item.version or 0)+1; item.updatedAt=next.updatedAt
 redis.call('SET',KEYS[1],cjson.encode(item)); return 'unchanged'
end
redis.call('SET',KEYS[1],ARGV[1]); redis.call('SADD',KEYS[2],KEYS[1]); redis.call('SADD',KEYS[3],KEYS[1]); return 'created'`;

export async function ensureClaudeAccountMetadata(store, { label, identity, policy = {}, now = new Date().toISOString() }) {
  label = normalizeLabel(label);
  if (!identity?.accountUuid || !identity?.organizationUuid || !identity?.emailAddress) throw new Error("Claude login returned incomplete account identity.");
  const record = { kind: "aimgr.credential.v1", provider: ANTHROPIC_PROVIDER, label, credential: {}, identity,
    policy: { ...policy, expect: { email: identity.emailAddress }, pool: policy.pool ?? { enabled: true } },
    health: { status: "candidate", reason: "local_login_required" }, provenance: {}, version: 1,
    createdAt: now, updatedAt: now, updatedBy: "aimgr-claude-local" };
  const outcome = await store.client.eval(ENSURE, {
    keys: [store.keys.credential({ provider: ANTHROPIC_PROVIDER, label }), store.keys.credentials(), store.keys.credentialsByProvider(ANTHROPIC_PROVIDER)],
    arguments: [JSON.stringify(record)],
  });
  if (!["created", "unchanged"].includes(outcome)) throw new Error(outcome === "duplicate_identity"
    ? "This Claude account and organization already belong to another label." : "This Claude label belongs to another account or organization.");
  return { outcome };
}

export async function updateClaudeEgressMetadata(store, { label, expectedVersion, egress }) {
  const result = await store.client.eval(`
-- AIMGR_CLAUDE_EGRESS_V1
local raw=redis.call('GET',KEYS[1]); if not raw then return 'missing' end
local item=cjson.decode(raw); if item.version~=tonumber(ARGV[1]) then return 'stale' end
item.policy=item.policy or {}; item.policy.egress=cjson.decode(ARGV[2]); item.version=item.version+1
redis.call('SET',KEYS[1],cjson.encode(item)); return 'ok'`, {
    keys:[store.keys.credential({provider:ANTHROPIC_PROVIDER,label:normalizeLabel(label)})],
    arguments:[String(expectedVersion),JSON.stringify(egress)] });
  if(result !== 'ok') throw new Error('Claude proxy assignment changed concurrently; reload and retry.');
}
