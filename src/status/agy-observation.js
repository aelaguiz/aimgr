import fs from "node:fs";
import path from "node:path";

const plans = new Map([
  ["starter", "Starter"], ["free", "Free"], ["pro", "Pro"], ["ultra", "Ultra"],
  ["enterprise", "Enterprise"], ["business", "Business"], ["standard", "Standard"],
]);
const bucketIds = new Set(["gemini-5h", "gemini-weekly", "claude-gpt-5h", "claude-gpt-weekly"]);
const groups = new Map([["gemini models", "gemini"], ["claude and gpt models", "claude-gpt"]]);
const maxTimeMs = 8.64e15;
const isTimestamp = value => Number.isSafeInteger(value) && value > 0 && value <= maxTimeMs;
const cachePath = accountHome => path.join(path.dirname(accountHome), "status.json");

function parseBucket(bucket) {
  if (!bucketIds.has(bucket?.id)) return null;
  const { id, remainingFraction, remainingAmount, resetAtMs, disabled } = bucket;
  const fraction = Number.isFinite(remainingFraction) && remainingFraction >= 0 && remainingFraction <= 1;
  const amount = Number.isFinite(remainingAmount) && remainingAmount >= 0;
  if (!fraction && !amount && disabled !== true) return null;
  return {
    id,
    ...(fraction ? { remainingFraction } : {}),
    ...(amount ? { remainingAmount } : {}),
    ...(isTimestamp(resetAtMs) ? { resetAtMs } : {}),
    ...(disabled === true ? { disabled } : {}),
  };
}

export function parseAgyObservation(value) {
  if (!isTimestamp(value?.observedAtMs) || !Array.isArray(value.buckets) || value.buckets.length > bucketIds.size) return null;
  const plan = typeof value.plan === "string" ? plans.get(value.plan.toLowerCase()) : undefined;
  const buckets = value.buckets.map(parseBucket).filter(Boolean);
  if (new Set(buckets.map(({ id }) => id)).size !== buckets.length || (!plan && buckets.length === 0)) return null;
  return { observedAtMs: value.observedAtMs, ...(plan ? { plan } : {}), buckets };
}

function commandData(report, expectedCommand) {
  if (typeof report !== "string") return null;
  try {
    const result = JSON.parse(report);
    if (result?.status !== "SUCCESS" || result.num_turns !== 0 || result.conversation_id !== ""
      || result.command?.name !== expectedCommand) return null;
    return result.command.data;
  } catch {
    return null;
  }
}

export function parseAgyNativeObservation(usageReport, creditsReport, observedAtMs) {
  const usage = commandData(usageReport, "usage");
  if (!Array.isArray(usage?.groups)) return null;
  const buckets = [];
  for (const group of usage.groups) {
    const key = typeof group?.name === "string" ? groups.get(group.name.toLowerCase()) : undefined;
    if (!key || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      const window = bucket?.window === "weekly" ? "weekly"
        : ["5h", "five_hour", "five-hour", "fivehour"].includes(bucket?.window) ? "5h" : null;
      if (!window) continue;
      const normalized = parseBucket({ id: `${key}-${window}`, remainingFraction: bucket.remaining_fraction,
        remainingAmount: bucket.remaining_amount, resetAtMs: Date.parse(bucket.reset_time), disabled: bucket.disabled });
      if (normalized) buckets.push(normalized);
    }
  }
  const planName = commandData(creditsReport, "credits")?.plan_name;
  const plan = typeof planName === "string"
    ? planName.trim().toLowerCase().replace(/^(antigravity|google ai|google one ai) /, "").replace(/ quota$/, "")
    : undefined;
  return parseAgyObservation({ observedAtMs, plan, buckets });
}

export function readAgyUsageCache(accountHome) {
  let fd;
  try {
    fd = fs.openSync(cachePath(accountHome), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > 4096) return null;
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    const observation = parseAgyObservation(value);
    return {
      observation,
      lastAttemptAtMs: isTimestamp(value?.lastAttemptAtMs) ? value.lastAttemptAtMs : observation?.observedAtMs,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readAgyObservation(accountHome) {
  return readAgyUsageCache(accountHome)?.observation ?? null;
}

// The caller holds the connection lock. Store only host-normalized fields next
// to the account home, outside the vendor and child tool state directories.
export function writeAgyUsageCache(accountHome, observation, lastAttemptAtMs = observation?.observedAtMs) {
  const safe = parseAgyObservation(observation);
  if (!isTimestamp(lastAttemptAtMs) || (observation && !safe)) throw new Error("Invalid Antigravity status observation.");
  const record = { ...safe, lastAttemptAtMs };
  const destination = cachePath(accountHome);
  const directory = fs.mkdtempSync(path.join(path.dirname(destination), ".status-"));
  try {
    const temporary = path.join(directory, "status.json");
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function clearAgyObservation(accountHome) {
  fs.rmSync(cachePath(accountHome), { force: true });
}
