import { XAI_PROVIDER } from "../core/constants.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { fetchXaiUsageSnapshot } from "../pool/usage.js";

function emailOf(record) {
  const identity = record?.identity?.emailAddress;
  const cred = record?.credential?.emailAddress;
  return String(identity || cred || "").trim().toLowerCase() || null;
}

export function collectXaiRedisAccountInventory(snapshot, { labels = null } = {}) {
  const wanted = Array.isArray(labels) && labels.length > 0 ? new Set(labels) : null;
  return (snapshot?.credentials ?? [])
    .filter((record) => record.provider === XAI_PROVIDER)
    .filter((record) => !wanted || wanted.has(record.label))
    .map((record) => ({
      label: record.label,
      email: emailOf(record),
      health: record.health?.status ?? null,
      expiresAt: record.credential?.expiresAt ?? null,
      expiresAtMs: parseExpiresAtToMs(record.credential?.expiresAt),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function renderXaiRedisAccountInventory(rows) {
  if (!rows.length) return "No xAI SuperGrok seats in Redis.\n";
  const lines = ["label\temail\thealth\texpires", ...rows.map((row) => (
    `${row.label}\t${row.email ?? "-"}\t${row.health ?? "-"}\t${row.expiresAt ?? "-"}`
  ))];
  return `${lines.join("\n")}\n`;
}

export async function collectXaiRedisAccountUsageStatus(snapshot, {
  labels = null,
  fetchXaiUsageSnapshotImpl = fetchXaiUsageSnapshot,
  timeoutMs = 15_000,
} = {}) {
  const inventory = collectXaiRedisAccountInventory(snapshot, { labels });
  const out = [];
  for (const row of inventory) {
    const record = (snapshot?.credentials ?? []).find(
      (item) => item.provider === XAI_PROVIDER && item.label === row.label,
    );
    const access = typeof record?.credential?.access === "string" ? record.credential.access : "";
    let usage = null;
    if (access) {
      usage = await fetchXaiUsageSnapshotImpl({
        accessToken: access,
        timeoutMs,
      });
    }
    out.push({
      ...row,
      usage,
    });
  }
  return out;
}

export function renderXaiRedisAccountUsageStatus(rows) {
  if (!rows.length) return "No xAI SuperGrok seats in Redis.\n";
  const lines = ["label\temail\ttier\tused/limit\tallow\texpires"];
  for (const row of rows) {
    const usage = row.usage;
    const tier = usage?.subscriptionTier ?? "-";
    const usedLimit = usage?.ok && usage.used != null && usage.limit != null
      ? `${usage.used}/${usage.limit}`
      : "-";
    const allow = usage?.ok ? (usage.allowAccess ? "yes" : "no") : "-";
    lines.push(`${row.label}\t${row.email ?? "-"}\t${tier}\t${usedLimit}\t${allow}\t${row.expiresAt ?? "-"}`);
  }
  return `${lines.join("\n")}\n`;
}
