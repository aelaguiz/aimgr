import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Claude Code keeps auto memory at <base>/projects/<project>/memory, and the
// base defaults to the config directory. Every managed account has its own
// config directory, so a memory saved on one account was invisible to the
// others. This variable moves only the memory base; Claude still names the
// per-project folder itself. Linking each account's memory folder to a shared
// one is not an alternative: Claude refuses memory reads and writes that
// resolve through a symlink to somewhere outside the config directory.
export const CLAUDE_SHARED_MEMORY_ENV_KEY = "CLAUDE_CODE_REMOTE_MEMORY_DIR";

// Claude loads only this much of a project's MEMORY.md at session start.
export const CLAUDE_MEMORY_INDEX_MAX_LINES = 200;
export const CLAUDE_MEMORY_INDEX_MAX_BYTES = 25_000;

const MEMORY_DIRNAME = "memory";
const MEMORY_INDEX_FILE = "MEMORY.md";
const SAFE_LABEL = /^[A-Za-z0-9_.-]+$/;
const INDEX_LINK_TARGET = /\]\(([^)\s]+)\)/;
const FOLD_LOCK_STALE_MS = 60_000;
// A file this fresh may still be mid-write by a live session.
const FOLD_SETTLE_MS = 2_000;

function requireAbsoluteHome(userHomeDir) {
  const raw = typeof userHomeDir === "string" ? userHomeDir.trim() : "";
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error("Shared Claude memory requires an absolute user home.");
  }
  return path.resolve(raw).normalize("NFC");
}

// The normal Claude home, so plain `claude` and every managed account share
// the same memories.
export function resolveClaudeSharedMemoryBase({ userHomeDir } = {}) {
  return path.join(requireAbsoluteHome(userHomeDir), ".claude");
}

function readEntries(dirPath, fsImpl) {
  try {
    return fsImpl.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}

function readOptional(filePath, fsImpl) {
  try {
    return fsImpl.readFileSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function unlinkOptional(filePath, fsImpl) {
  try {
    fsImpl.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function isRealDirectory(dirPath, fsImpl) {
  try {
    return fsImpl.lstatSync(dirPath).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function listMemoryFiles(dirPath, fsImpl) {
  if (!isRealDirectory(dirPath, fsImpl)) return [];
  return readEntries(dirPath, fsImpl)
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function listAccountMemorySources({ homesRoot, fsImpl, nowMs }) {
  const sources = [];
  for (const home of readEntries(homesRoot, fsImpl)) {
    if (!home.isDirectory() || !SAFE_LABEL.test(home.name)) continue;
    const projectsDir = path.join(homesRoot, home.name, ".claude", "projects");
    for (const project of readEntries(projectsDir, fsImpl)) {
      if (!project.isDirectory()) continue;
      const dir = path.join(projectsDir, project.name, MEMORY_DIRNAME);
      const files = [];
      let settled = true;
      for (const name of listMemoryFiles(dir, fsImpl)) {
        let stat;
        try {
          stat = fsImpl.statSync(path.join(dir, name));
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        if (stat.mtimeMs > nowMs - FOLD_SETTLE_MS) settled = false;
        files.push({ name, mtimeMs: stat.mtimeMs });
      }
      if (files.length === 0 || !settled) continue;
      sources.push({ label: home.name, project: project.name, dir, files });
    }
  }
  return sources;
}

function acquireFoldLock(lockPath, { fsImpl, nowMs }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fsImpl.mkdirSync(lockPath);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let ageMs;
    try {
      ageMs = nowMs - fsImpl.statSync(lockPath).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs < FOLD_LOCK_STALE_MS) return false;
    try {
      fsImpl.rmdirSync(lockPath);
    } catch {
      // Another launch reclaimed it first.
    }
  }
  return false;
}

// Creates the file only if nothing is there, so a memory already in the shared
// store is never overwritten. The save date survives because Claude reads a
// memory's age from its modification time.
function writeNewFile(destPath, bytes, mtimeMs, fsImpl) {
  const tempPath = path.join(
    path.dirname(destPath),
    `.${path.basename(destPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fsImpl.writeFileSync(tempPath, bytes, { flag: "wx" });
    const mtime = new Date(mtimeMs);
    fsImpl.utimesSync(tempPath, mtime, mtime);
    fsImpl.linkSync(tempPath, destPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkOptional(tempPath, fsImpl);
  }
}

function placeMemoryFile({ destDir, name, label, bytes, mtimeMs, fsImpl }) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const candidates = [
    { name, outcome: "moved" },
    { name: `${stem}--${label}${ext}`, outcome: "variant" },
    { name: `${stem}--${label}-${digest}${ext}`, outcome: "variant" },
  ];
  for (const candidate of candidates) {
    const destPath = path.join(destDir, candidate.name);
    let existing = readOptional(destPath, fsImpl);
    if (existing === null) {
      if (writeNewFile(destPath, bytes, mtimeMs, fsImpl)) return candidate;
      existing = readOptional(destPath, fsImpl);
    }
    if (existing?.equals(bytes)) return { name: candidate.name, outcome: "identical" };
    // Several accounts often hold the same differing text; keep it once.
    for (const other of listMemoryFiles(destDir, fsImpl)) {
      if (!other.startsWith(`${stem}--`) || path.extname(other) !== ext) continue;
      if (readOptional(path.join(destDir, other), fsImpl)?.equals(bytes)) {
        return { name: other, outcome: "identical" };
      }
    }
  }
  throw new Error("Could not place a Claude memory without overwriting another.");
}

function readFrontmatterField(text, field) {
  if (!text.startsWith("---\n")) return "";
  const end = text.indexOf("\n---", 4);
  if (end < 0) return "";
  const match = new RegExp(`^${field}:[ \\t]*(.+)$`, "m").exec(text.slice(4, end));
  return match ? match[1].trim().replace(/^(["'])(.*)\1$/, "$2") : "";
}

function indexLineFor({ sourceName, sourceLine, placedName, label, bytes }) {
  if (path.extname(placedName) !== ".md") return null;
  const renamed = placedName !== sourceName;
  let line = sourceLine;
  if (line && renamed) line = line.replace(`](${sourceName})`, `](${placedName})`);
  if (!line) {
    const text = bytes.toString("utf8");
    const title = readFrontmatterField(text, "name") || placedName.slice(0, -3);
    const description = readFrontmatterField(text, "description");
    line = `- [${title}](${placedName})${description ? ` — ${description}` : ""}`;
  }
  return renamed ? `${line} (version saved on ${label})` : line;
}

function readSourceIndex(dir, fsImpl) {
  const byTarget = new Map();
  const loose = [];
  const raw = readOptional(path.join(dir, MEMORY_INDEX_FILE), fsImpl);
  for (const rawLine of (raw?.toString("utf8") ?? "").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const target = INDEX_LINK_TARGET.exec(line)?.[1];
    if (!target) loose.push(line);
    else if (!byTarget.has(target)) byTarget.set(target, line);
  }
  return { byTarget, loose };
}

// Adds lines the shared index lacks, newest first and directly under its
// title, so the memories saved most recently stay inside the part of the
// index Claude loads.
function mergeIndex({ destDir, additions, fsImpl }) {
  const indexPath = path.join(destDir, MEMORY_INDEX_FILE);
  const existing = readOptional(indexPath, fsImpl)?.toString("utf8") ?? "";
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");
  const targets = new Set();
  const literal = new Set();
  for (const line of lines) {
    const target = INDEX_LINK_TARGET.exec(line)?.[1];
    if (target) targets.add(target);
    literal.add(line.trim());
  }
  const fresh = [];
  for (const { target, line } of additions) {
    const seen = target === null ? literal : targets;
    const key = target === null ? line.trim() : target;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(line);
  }
  if (fresh.length === 0) return;
  fresh.reverse();

  let at = 0;
  while (at < lines.length && lines[at].trim() === "") at += 1;
  if (at < lines.length && /^#\s/.test(lines[at])) {
    at += 1;
    while (at < lines.length && lines[at].trim() === "") at += 1;
  } else {
    at = 0;
  }
  lines.splice(at, 0, ...fresh);

  const tempPath = path.join(destDir, `.${MEMORY_INDEX_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(tempPath, `${lines.join("\n")}\n`, { flag: "wx" });
    fsImpl.renameSync(tempPath, indexPath);
  } finally {
    unlinkOptional(tempPath, fsImpl);
  }
}

function foldProject({ destDir, sources, fsImpl }) {
  fsImpl.mkdirSync(destDir, { recursive: true });
  const incoming = [];
  const additions = [];
  for (const source of sources) {
    source.index = readSourceIndex(source.dir, fsImpl);
    source.counts = { moved: 0, identical: 0, variant: 0 };
    const names = new Set(source.files.map(({ name }) => name));
    for (const [target, line] of source.index.byTarget) {
      if (!names.has(target) && readOptional(path.join(destDir, target), fsImpl) !== null) {
        additions.push({ target, line });
      }
    }
    for (const line of source.index.loose) additions.push({ target: null, line });
    for (const file of source.files) {
      if (file.name !== MEMORY_INDEX_FILE) incoming.push({ ...file, source });
    }
  }
  incoming.sort((a, b) => (
    a.mtimeMs - b.mtimeMs
    || a.source.label.localeCompare(b.source.label)
    || a.name.localeCompare(b.name)
  ));

  for (const { name, mtimeMs, source } of incoming) {
    const sourcePath = path.join(source.dir, name);
    const bytes = readOptional(sourcePath, fsImpl);
    if (bytes === null) continue;
    const placed = placeMemoryFile({ destDir, name, label: source.label, bytes, mtimeMs, fsImpl });
    unlinkOptional(sourcePath, fsImpl);
    source.counts[placed.outcome] += 1;
    const line = indexLineFor({
      sourceName: name,
      sourceLine: source.index.byTarget.get(name) ?? null,
      placedName: placed.name,
      label: source.label,
      bytes,
    });
    if (line) additions.push({ target: placed.name, line });
  }

  mergeIndex({ destDir, additions, fsImpl });
  for (const source of sources) unlinkOptional(path.join(source.dir, MEMORY_INDEX_FILE), fsImpl);
  return sources.map(({ label, project, counts }) => ({ label, project, ...counts }));
}

// Moves memories that a session saved in its own account home into the shared
// store. Sessions started before this existed, or by a Claude build that stops
// honoring the memory base, keep writing there; each launch sweeps them up.
// Nothing in the shared store is overwritten: a same-named memory with
// different text is kept beside it as `<name>--<label>.md`.
export function foldManagedClaudeMemories({
  userHomeDir,
  fsImpl = fs,
  nowMs = Date.now(),
} = {}) {
  const resolvedHome = requireAbsoluteHome(userHomeDir);
  const aimgrRoot = path.join(resolvedHome, ".aimgr");
  const sources = listAccountMemorySources({
    homesRoot: path.join(aimgrRoot, "claude-homes"),
    fsImpl,
    nowMs,
  });
  if (sources.length === 0) return { busy: false, folded: [] };

  const lockPath = path.join(aimgrRoot, "claude-memory-fold.lock");
  if (!acquireFoldLock(lockPath, { fsImpl, nowMs })) return { busy: true, folded: [] };
  try {
    const sharedProjects = path.join(resolveClaudeSharedMemoryBase({ userHomeDir: resolvedHome }), "projects");
    const byProject = new Map();
    for (const source of sources) {
      if (!byProject.has(source.project)) byProject.set(source.project, []);
      byProject.get(source.project).push(source);
    }
    const folded = [];
    for (const [project, projectSources] of byProject) {
      folded.push(...foldProject({
        destDir: path.join(sharedProjects, project, MEMORY_DIRNAME),
        sources: projectSources,
        fsImpl,
      }));
    }
    return { busy: false, folded };
  } finally {
    try {
      fsImpl.rmdirSync(lockPath);
    } catch {
      // A stale-lock reclaim already removed it.
    }
  }
}

export function describeFoldedClaudeMemories(folded) {
  const moved = folded.filter(({ moved: count, variant }) => count + variant > 0);
  if (moved.length === 0) return null;
  const count = moved.reduce((sum, entry) => sum + entry.moved + entry.variant, 0);
  const variants = moved.reduce((sum, entry) => sum + entry.variant, 0);
  const labels = [...new Set(moved.map(({ label }) => label))].sort();
  return `Moved ${count} Claude ${count === 1 ? "memory" : "memories"} saved under ${labels.join(", ")} into the shared memory store`
    + `${variants > 0 ? ` (${variants} kept as a separate version of a memory already there)` : ""}.`;
}

export function summarizeClaudeSharedMemory({ userHomeDir, fsImpl = fs } = {}) {
  const base = resolveClaudeSharedMemoryBase({ userHomeDir });
  const projectsDir = path.join(base, "projects");
  const projects = [];
  for (const project of readEntries(projectsDir, fsImpl)) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name, MEMORY_DIRNAME);
    const memories = listMemoryFiles(dir, fsImpl).filter((name) => name !== MEMORY_INDEX_FILE).length;
    if (memories === 0) continue;
    const index = readOptional(path.join(dir, MEMORY_INDEX_FILE), fsImpl) ?? Buffer.alloc(0);
    const indexLines = index.length === 0 ? 0 : index.toString("utf8").replace(/\n$/, "").split("\n").length;
    projects.push({
      project: project.name,
      memories,
      indexLines,
      indexBytes: index.length,
      overLimit: indexLines > CLAUDE_MEMORY_INDEX_MAX_LINES || index.length > CLAUDE_MEMORY_INDEX_MAX_BYTES,
    });
  }
  projects.sort((a, b) => b.memories - a.memories || a.project.localeCompare(b.project));
  return { base, projects };
}

export function renderClaudeSharedMemoryReport({ summary, fold }) {
  const lines = [
    `Shared Claude memory: ${path.join(summary.base, "projects", "<project>", MEMORY_DIRNAME)}`,
    "Every AIM-launched Claude account reads and saves memories there.",
    "",
  ];
  const notice = describeFoldedClaudeMemories(fold.folded);
  if (fold.busy) lines.push("Another launch is moving memories in right now; run this again in a moment.", "");
  else if (notice) lines.push(notice, "");
  if (summary.projects.length === 0) {
    lines.push("No memories saved yet.");
    return `${lines.join("\n")}\n`;
  }
  const width = Math.max(...summary.projects.map(({ project }) => project.length), "PROJECT".length);
  lines.push(`${"PROJECT".padEnd(width)}  MEMORIES  INDEX`);
  for (const entry of summary.projects) {
    lines.push(
      `${entry.project.padEnd(width)}  ${String(entry.memories).padStart(8)}  `
      + `${entry.indexLines} ${entry.indexLines === 1 ? "line" : "lines"}, ${(entry.indexBytes / 1000).toFixed(1)} KB`
      + `${entry.overLimit ? "  OVER LIMIT" : ""}`,
    );
  }
  if (summary.projects.some(({ overLimit }) => overLimit)) {
    lines.push(
      "",
      `OVER LIMIT: Claude loads only the first ${CLAUDE_MEMORY_INDEX_MAX_LINES} lines or `
      + `${CLAUDE_MEMORY_INDEX_MAX_BYTES / 1000} KB of a project's MEMORY.md. Every memory file is still on disk, `
      + "but entries past that point are not loaded at session start.",
    );
  }
  return `${lines.join("\n")}\n`;
}
