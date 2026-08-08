import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAimgrStateDir } from "../io/paths.js";

const JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const GENERATION_PATTERN = /^(\d{16})-([0-9a-f]{64})\.json$/u;

function operationKey(operationId) {
  return createHash("sha256").update(operationId, "utf8").digest("hex");
}

function digestJournal(journal) {
  return createHash("sha256").update(JSON.stringify(journal), "utf8").digest("hex");
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function fsyncDirectory(dirPath, { fsImpl = fs } = {}) {
  const fd = fsImpl.openSync(dirPath, "r");
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

function ensurePrivateDirectory(dirPath, { fsImpl = fs } = {}) {
  let created = false;
  try {
    const stat = fsImpl.lstatSync(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Refusing unsafe AIM Prime create journal directory.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fsImpl.mkdirSync(dirPath, { mode: 0o700 });
    created = true;
  }
  fsImpl.chmodSync(dirPath, 0o700);
  if (created) fsyncDirectory(path.dirname(dirPath), { fsImpl });
}

export function resolvePrimeCreateJournalOperationDir({ homeDir, operationId }) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    throw new Error("AIM Prime create journal requires an absolute home directory.");
  }
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new Error("AIM Prime create journal requires an operation identity.");
  }
  return path.join(
    resolveAimgrStateDir({ homeDir }),
    "prime-create-journal",
    operationKey(operationId),
  );
}

function readGeneration(filePath, {
  operationId,
  expectedOperationKey,
  expectedRevision,
  expectedDigest,
  fsImpl = fs,
} = {}) {
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JOURNAL_BYTES) {
    throw new Error("AIM Prime create journal generation is invalid.");
  }
  const raw = fsImpl.readFileSync(filePath, "utf8");
  if (Buffer.byteLength(raw, "utf8") !== stat.size) {
    throw new Error("AIM Prime create journal generation is invalid.");
  }
  const envelope = JSON.parse(raw);
  const envelopeKeys = [
    "schemaVersion",
    "operationId",
    "operationKey",
    "revision",
    "journalDigest",
    "journal",
  ];
  if (
    !exactKeys(envelope, envelopeKeys)
    || envelope.schemaVersion !== JOURNAL_SCHEMA_VERSION
    || envelope.operationId !== operationId
    || envelope.operationKey !== expectedOperationKey
    || envelope.revision !== expectedRevision
    || envelope.journalDigest !== expectedDigest
    || !isObject(envelope.journal)
    || envelope.journal.operationId !== operationId
    || digestJournal(envelope.journal) !== expectedDigest
  ) {
    throw new Error("AIM Prime create journal generation is invalid.");
  }
  return envelope.journal;
}

export function readPrimeCreateJournal({ homeDir, operationId, fsImpl = fs } = {}) {
  const operationDir = resolvePrimeCreateJournalOperationDir({ homeDir, operationId });
  let entries;
  try {
    const stat = fsImpl.lstatSync(operationDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { status: "corrupt", journal: null, revision: 0, maxRevision: 0, recovered: false };
    }
    entries = fsImpl.readdirSync(operationDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "not_found", journal: null, revision: 0, maxRevision: 0, recovered: false };
    }
    return { status: "corrupt", journal: null, revision: 0, maxRevision: 0, recovered: false };
  }

  const generations = [];
  let interruptedWritePresent = false;
  for (const name of entries) {
    const match = GENERATION_PATTERN.exec(name);
    if (!match) {
      if (name.startsWith(".write-")) interruptedWritePresent = true;
      continue;
    }
    const revision = Number(match[1]);
    if (!Number.isSafeInteger(revision) || revision <= 0) continue;
    generations.push({ name, revision, digest: match[2] });
  }
  generations.sort((left, right) => right.revision - left.revision || right.name.localeCompare(left.name));
  const maxRevision = generations[0]?.revision ?? 0;
  let invalidGenerationPresent = interruptedWritePresent;
  const expectedOperationKey = operationKey(operationId);
  for (const generation of generations) {
    try {
      const journal = readGeneration(path.join(operationDir, generation.name), {
        operationId,
        expectedOperationKey,
        expectedRevision: generation.revision,
        expectedDigest: generation.digest,
        fsImpl,
      });
      return {
        status: invalidGenerationPresent ? "recovered" : "ok",
        journal,
        revision: generation.revision,
        maxRevision,
        recovered: invalidGenerationPresent,
      };
    } catch {
      invalidGenerationPresent = true;
    }
  }
  return {
    status: generations.length > 0 || interruptedWritePresent ? "corrupt" : "not_found",
    journal: null,
    revision: 0,
    maxRevision,
    recovered: false,
  };
}

export function writePrimeCreateJournal({ homeDir, journal, fsImpl = fs } = {}) {
  if (!isObject(journal) || typeof journal.operationId !== "string" || journal.operationId.length === 0) {
    throw new Error("AIM Prime create journal is invalid.");
  }
  const operationId = journal.operationId;
  const operationDir = resolvePrimeCreateJournalOperationDir({ homeDir, operationId });
  const stateDir = resolveAimgrStateDir({ homeDir });
  const journalRoot = path.dirname(operationDir);
  for (const dirPath of [stateDir, journalRoot, operationDir]) {
    ensurePrivateDirectory(dirPath, { fsImpl });
  }

  const current = readPrimeCreateJournal({ homeDir, operationId, fsImpl });
  const revision = current.maxRevision + 1;
  if (!Number.isSafeInteger(revision) || revision <= 0 || revision > 9_999_999_999_999_999) {
    throw new Error("AIM Prime create journal revision is invalid.");
  }
  const journalCopy = structuredClone(journal);
  const journalDigest = digestJournal(journalCopy);
  const envelope = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    operationId,
    operationKey: operationKey(operationId),
    revision,
    journalDigest,
    journal: journalCopy,
  };
  const body = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_JOURNAL_BYTES) {
    throw new Error("AIM Prime create journal is too large.");
  }
  const stem = `${String(revision).padStart(16, "0")}-${journalDigest}`;
  const finalPath = path.join(operationDir, `${stem}.json`);
  const tempPath = path.join(
    operationDir,
    `.write-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`,
  );
  let fd = null;
  let renamed = false;
  try {
    fd = fsImpl.openSync(tempPath, "wx", 0o600);
    fsImpl.writeFileSync(fd, body, "utf8");
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(tempPath, finalPath);
    renamed = true;
    fsyncDirectory(operationDir, { fsImpl });
  } finally {
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        // Preserve the original durable-write failure.
      }
    }
    if (!renamed) {
      try {
        fsImpl.unlinkSync(tempPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return Object.freeze({ path: finalPath, revision, recoveredPriorGeneration: current.recovered });
}
