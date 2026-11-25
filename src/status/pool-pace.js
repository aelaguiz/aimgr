const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SAMPLE_SPACING_MS = 10 * 60_000;
const HISTORY_MS = DAY_MS + HOUR_MS;

// A single Redis command checks the latest reading, appends, and trims so
// status running on two machines cannot overwrite or duplicate a reading.
const RECORD_WEEKLY_USAGE = `
-- AIMGR_WEEKLY_USAGE_V1
local raw = redis.call('GET', KEYS[1])
local history = raw and cjson.decode(raw) or {}
local sample = cjson.decode(ARGV[1])
local cutoff = tonumber(ARGV[2])
local spacing = tonumber(ARGV[3])
local windowStart = tonumber(ARGV[4])
local now = windowStart + ${DAY_MS}
local recent = {}
for _, entry in ipairs(history) do
  if entry.observedAtMs >= cutoff then table.insert(recent, entry) end
end
local changed = #recent ~= #history
local newest = recent[#recent]
if sample ~= cjson.null and sample.observedAtMs >= cutoff
  and (not newest or sample.observedAtMs - newest.observedAtMs >= spacing) then
  table.insert(recent, sample)
  changed = true
end
if changed then
  if #recent == 0 then
    redis.call('DEL', KEYS[1])
  else
    local ttl = math.max(1, recent[#recent].observedAtMs - cutoff)
    redis.call('SET', KEYS[1], cjson.encode(recent), 'PX', ttl)
  end
end
local used = 0
local start = nil
local previous = nil
for _, entry in ipairs(recent) do
  if entry.observedAtMs > now then break end
  if entry.observedAtMs >= windowStart and previous
    and type(previous.weekResetAt) == 'number' and type(entry.weekResetAt) == 'number' then
    local shift = entry.weekResetAt - previous.weekResetAt
    if shift >= -${HOUR_MS} then
      local rise = shift > ${HOUR_MS} and entry.weekUsedPercent
        or math.max(0, entry.weekUsedPercent - previous.weekUsedPercent)
      used = used + rise
      if not start or previous.observedAtMs < start then start = previous.observedAtMs end
    end
  end
  previous = entry
end
-- Lua number replies truncate to integers. Send the percentage as a decimal string.
return {string.format('%.17g', used), start}
`;

export function computePoolPace(pool, perAccount, nowMs) {
  let used = 0;
  let earliestStart = nowMs;
  for (const account of pool.accountRows) {
    const [usedPercent, startMs] = perAccount.get(account.label) ?? [0];
    used += account.weight * usedPercent / 100;
    if (startMs !== undefined) earliestStart = Math.min(earliestStart, startMs);
  }

  const hours = Math.min(24, (nowMs - earliestStart) / HOUR_MS);
  if (hours < 2) return null;
  const perDay = used / hours * 24;
  let lastsUntilMs = null;
  if (perDay > 0) {
    const horizon = nowMs + 7 * DAY_MS;
    const resets = pool.accountRows
      .filter((row) => row.weekResetAt > nowMs && row.weekResetAt <= horizon && row.weekUsedPercent > 0)
      .map((row) => ({ at: row.weekResetAt, used: row.weight * row.weekUsedPercent / 100 }))
      .sort((a, b) => a.at - b.at);
    resets.push({ at: horizon, used: 0 });
    const usedPerMs = perDay / DAY_MS;
    let left = pool.left;
    let cursor = nowMs;
    for (const reset of resets) {
      const depletedAt = cursor + left / usedPerMs;
      if (depletedAt < reset.at) {
        lastsUntilMs = Math.round(depletedAt);
        break;
      }
      left += reset.used - usedPerMs * (reset.at - cursor);
      cursor = reset.at;
    }
  }
  return { used, hours, perDay, lastsUntilMs };
}

export async function recordStatusPoolPace(store, pools, nowMs) {
  const results = await Promise.all(Object.entries(pools).map(async ([name, pool]) => {
    const perAccount = await Promise.all(pool.accountRows.map(async ({
      label, observedAtMs, weekUsedPercent, weekResetAt,
    }) => {
      const sample = observedAtMs !== null && weekUsedPercent !== null
        ? { observedAtMs, weekUsedPercent, weekResetAt }
        : null;
      const [usedPercent, startMs] = await store.client.eval(RECORD_WEEKLY_USAGE, {
        keys: [store.keys.poolUsage({ pool: name, label })],
        arguments: [JSON.stringify(sample), String(nowMs - HISTORY_MS), String(SAMPLE_SPACING_MS), String(nowMs - DAY_MS)],
      });
      return [label, [Number(usedPercent), startMs]];
    }));
    return [pool, computePoolPace(pool, new Map(perAccount), nowMs)];
  }));
  for (const [pool, pace] of results) pool.pace = pace;
}
