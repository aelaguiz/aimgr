import fs from "node:fs";
import path from "node:path";
import { formatTimestampForBackup } from "../core/time.js";

export function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${filePath} (${err.message})`);
  }
}

export function writeJsonFileWithBackup(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak.${formatTimestampForBackup()}`;
    fs.copyFileSync(filePath, backupPath);
  }
  const json = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(filePath, json, { encoding: "utf8" });
}

export function writeJsonFileWithBackupIfChanged(filePath, data) {
  const next = `${JSON.stringify(data, null, 2)}\n`;
  let current = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
  if (current === next) {
    return { wrote: false, path: filePath };
  }
  writeJsonFileWithBackup(filePath, data);
  return { wrote: true, path: filePath };
}

export function writeTextFileIfChanged(filePath, text, { mode } = {}) {
  const next = String(text ?? "");
  let current = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
  if (current === next) {
    return { wrote: false, path: filePath };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, {
    encoding: "utf8",
    ...(mode !== undefined ? { mode } : {}),
  });
  return { wrote: true, path: filePath };
}

export function writeJsonFileIfChanged(filePath, data, { mode } = {}) {
  return writeTextFileIfChanged(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode });
}

export function ensureDirectoryMode(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  try {
    fs.chmodSync(dirPath, mode);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}
