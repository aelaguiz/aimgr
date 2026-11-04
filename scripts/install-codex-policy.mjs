#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { codexManagedPolicyText } from "../src/privacy/codex-managed-policy.js";
import { inspectCodexAdministratorPath } from "../src/privacy/codex-artifacts.js";

if (process.getuid() !== 0 || process.argv.length !== 2) throw new Error("Install Codex privacy policy as administrator, with no path overrides.");
const directory = path.join(fs.realpathSync("/etc"), "codex");
inspectCodexAdministratorPath(directory);
fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
const inputs = {};
const files = { config: path.join(directory, "managed_config.toml"), requirements: path.join(directory, "requirements.toml") };
for (const [key, file] of Object.entries(files)) {
  const input = inspectCodexAdministratorPath(file);
  if (input && input.kind !== "file") throw new Error("Existing Codex managed policy is not a regular file.");
  inputs[key] = input?.bytes.toString("utf8") ?? "";
}
const output = codexManagedPolicyText(inputs);
for (const [key, file] of Object.entries(files)) {
  if (output[key] === inputs[key]) continue;
  // Preserve exact existing policy privately before its first modification.
  if (inputs[key]) {
    const backup = `${file}.before-aim-${randomUUID()}`;
    const fd = fs.openSync(backup, "wx", 0o600);
    try { fs.writeFileSync(fd, inputs[key]); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const staged = `${file}.${randomUUID()}`;
  const fd = fs.openSync(staged, "wx", 0o644);
  try { fs.writeFileSync(fd, output[key]); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(staged, file);
  const directoryFd = fs.openSync(directory, "r");
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}
process.stdout.write("Codex managed privacy policy installed; unrelated policy and independent exporters preserved.\n");
