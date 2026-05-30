import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAimgrMachineIdPath } from "../io/paths.js";

function normalizeMachineId(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || null;
}

function defaultMachineId() {
  const host = normalizeMachineId(os.hostname()) || "machine";
  return `${host}-${crypto.randomUUID().slice(0, 8)}`;
}

export function getOrCreateMachineId({ homeDir }) {
  const machineIdPath = resolveAimgrMachineIdPath({ homeDir });
  if (fs.existsSync(machineIdPath)) {
    const existing = normalizeMachineId(fs.readFileSync(machineIdPath, "utf8"));
    if (existing) return { machineId: existing, path: machineIdPath, created: false };
  }
  const machineId = defaultMachineId();
  fs.mkdirSync(path.dirname(machineIdPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(machineIdPath, `${machineId}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(machineIdPath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  return { machineId, path: machineIdPath, created: true };
}

export function buildLocalMachineInfo({ homeDir, aimVersion = "0.0.0", now = new Date() }) {
  const { machineId, path: machineIdPath, created } = getOrCreateMachineId({ homeDir });
  return {
    machineId,
    machineIdPath,
    created,
    hostname: os.hostname(),
    displayName: os.hostname(),
    platform: process.platform,
    aimVersion,
    observedAt: now.toISOString(),
  };
}
