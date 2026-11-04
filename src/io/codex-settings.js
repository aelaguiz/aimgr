import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { codexStateIO, durableCodexWrite } from "./codex-state-io.js";
import { mergeCodexSettings, projectCodexSettings, parseCodexSettings } from "./codex-settings-toml.js";
import { applyCodexSettingsIntents, consumeCodexSettingsIntents } from "./codex-settings-intents.js";

const digest = text => createHash("sha256").update(text).digest("hex");
function read(file) { try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
function identity(file) {
  try { const st = fs.statSync(file); return `${st.dev}:${st.ino}`; }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function resolvedTarget(file, depth = 0) {
  if (depth > 40) throw new Error("Codex settings symlink depth exceeds the native limit.");
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { const st = fs.lstatSync(file); if (st.isSymbolicLink()) return resolvedTarget(path.resolve(path.dirname(file), fs.readlinkSync(file)), depth + 1); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  }
}
function atomicRecord(file, value) {
  const staged = `${file}.${randomUUID()}`;
  durableCodexWrite(staged, JSON.stringify(value) + "\n", { exclusive: true });
  fs.renameSync(staged, file);
  flushParent(file);
}
function flushParent(file, allowUnreadable = false) {
  let fd;
  try { fd = fs.openSync(path.dirname(file), "r"); }
  catch (error) { if (allowUnreadable && error.code === "EACCES") return false; throw error; }
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return true;
}
function removeRecord(file) { fs.unlinkSync(file); flushParent(file); }
function valid(text) { try { parseCodexSettings(text ?? ""); return true; } catch { return false; } }
function preservePublication(entry, state, operation) {
  if (operation.kind !== "source" || typeof operation.candidate !== "string") return;
  const file = operation.durabilityRecovery ?? path.join(entry.directory, `unsynced-source-${randomUUID()}.toml`);
  if (!fs.existsSync(file)) durableCodexWrite(file, operation.candidate, { exclusive: true });
  operation.durabilityRecovery = file;
  if (!(state.preservedCopies ?? []).includes(file)) (state.preservedCopies ??= []).push(file);
}

export function codexSettingsView({ base, source, home }) {
  const origin = path.resolve(source);
  const directory = path.join(base, "codex-settings", digest(origin));
  return Object.freeze({ origin, home, directory, view: path.join(directory, "view", "config.toml"),
    record: path.join(directory, "state.json"), journal: path.join(directory, "transaction.json"),
    base, options: { source: origin, home } });
}

/** Reconcile one authored file and its shared native view. The caller owns this
 * only while its invocation is alive. Native/editor writers ignore our lock,
 * so each replaced inode remains in a recovery record, including late FD writes.
 */
export async function reconcileCodexSettings(entry, { stateIO = codexStateIO, onWarning = () => {}, fault = () => {} } = {}) {
  fs.mkdirSync(path.dirname(entry.view), { recursive: true, mode: 0o700 });
  const refuseUnreadableSource = error => {
    if (["EACCES", "EPERM"].includes(error.code)) {
      // Preserve the view's bytes and pending writes, but do not let native
      // read stale settings or atomically replace them while their authoring
      // source is unreadable. Records and journals live outside this folder.
      fs.chmodSync(path.dirname(entry.view), 0o000);
    }
    throw error;
  };
  let target;
  try {
    fs.mkdirSync(path.dirname(entry.origin), { recursive: true, mode: 0o700 });
    target = resolvedTarget(entry.origin);
  } catch (error) { refuseUnreadableSource(error); }
  // Lock the actual authored target, so two lexical origins cannot write it
  // through independently acquired AIM locks. Each still has its own view.
  const lockTarget = path.join(entry.base, "codex-settings", `source-${digest(target)}`);
  const release = await lockfile.lock(lockTarget, { realpath: false, retries: { retries: 30, minTimeout: 10, maxTimeout: 100 }, stale: 30_000 });
  let writable = true, sourceReadable = false;
  try {
    let sourceSnapshot;
    try { sourceSnapshot = read(target); }
    catch (error) { refuseUnreadableSource(error); }
    sourceReadable = true;
    // Check the source before reopening a previously blocked view. Pending
    // recovery must be able to inspect every displaced inode: existsSync on
    // an inaccessible view folder would mistake it for a missing file.
    if ((fs.statSync(path.dirname(entry.view)).mode & 0o777) === 0o000) fs.chmodSync(path.dirname(entry.view), 0o700);
    writable = stateIO({ operation: "settings-replaceable", path: target }).writable === true;
    let state = JSON.parse(read(entry.record) ?? "null") ?? { schema: 1, source: "", view: "", retained: [], warningKeys: [] };
    const previousRecord = JSON.stringify(state);
    if (state.schema !== 1) throw new Error(`Unsupported Codex settings record for ${entry.origin}.`);
    if (state.consumedIntents?.length) {
      consumeCodexSettingsIntents(state.consumedIntents);
      delete state.consumedIntents;
    }
    const pending = JSON.parse(read(entry.journal) ?? "null");
    if (pending) {
      // If staged's inode is still present there, the exchange did not happen.
      // If it differs, it is the displaced writer's inode. A native replacement
      // of the target after exchange does not obscure that distinction.
      for (const op of pending.operations) {
        // A crash leaves publication durability unknown. Preserve its proposed
        // bytes before the private journal is cleared; never replay over source.
        preservePublication(entry, state, op);
        if (op.durabilityRecovery && !(state.preservedCopies ?? []).includes(op.durabilityRecovery)) {
          (state.preservedCopies ??= []).push(op.durabilityRecovery);
        }
        if (!fs.existsSync(op.staged)) continue;
        const swapped = identity(op.staged) !== op.stagedIdentity;
        if (swapped && !state.retained.some(r => r.path === op.staged)) {
          state.retained.push({ path: op.staged, observed: op.expected, kind: op.kind });
        } else if (!swapped && identity(op.target) !== op.stagedIdentity) {
          fs.unlinkSync(op.staged); // Our unpublished candidate, never a writer's file.
        }
      }
      atomicRecord(entry.record, state);
      removeRecord(entry.journal);
    }
    const viewSnapshot = read(entry.view);
    let source = sourceSnapshot, view = viewSnapshot;
    fault("after-read");
    const initial = read(entry.record) === null;
    if (initial && view !== null) throw new Error(`Unowned Codex settings view for ${entry.origin}.`);
    const recovered = [];
    // Consume deltas from retained inodes before the ordinary source/view merge.
    // Keep bytes recoverable even when a conflict or invalid edit prevents apply.
    for (const retained of state.retained) {
      const current = read(retained.path);
      if (current === null || current === retained.observed) continue;
      try {
        const base = retained.observed ?? "";
        const change = mergeCodexSettings({ baseSource: base,
          baseView: projectCodexSettings(base, entry.options),
          source: retained.kind === "source" ? current : source ?? "",
          view: retained.kind === "source" ? projectCodexSettings(source ?? "", entry.options) : current,
          origin: entry.origin, home: entry.home });
        let recovery = retained.path;
        if (retained.kind === "source" && change.conflicts.length) {
          recovery = path.join(entry.directory, `conflict-${randomUUID()}.toml`);
          durableCodexWrite(recovery, source ?? "", { exclusive: true });
        }
        source = change.source;
        recovered.push(...change.conflicts.map(keys => ({ keys, recovery })));
        retained.observed = current;
      } catch {
        recovered.push({ keys: ["invalid retained settings"], recovery: retained.path });
      }
    }
    let candidate;
    const sourceValid = valid(source);
    if (!sourceValid || !valid(view) || !valid(state.source) || !valid(state.view)) {
      // Invalid current authored bytes reach native unchanged. Invalid OLD
      // bytes must never prevent a valid repair from being path-normalized.
      if (view !== null && view !== state.view) {
        const recovery = path.join(entry.directory, `invalid-view-${randomUUID()}.toml`);
        durableCodexWrite(recovery, view, { exclusive: true });
        onWarning({ source: entry.origin, keys: [], recovery, reason: "invalid settings" });
      }
      candidate = { source: source ?? "", view: sourceValid ? projectCodexSettings(source ?? "", entry.options) : source ?? "", conflicts: [] };
    } else if (initial) candidate = { source: source ?? "", view: projectCodexSettings(source ?? "", entry.options), conflicts: [] };
    else candidate = mergeCodexSettings({ baseSource: state.source, baseView: state.view,
      source: source ?? "", view: view ?? "", origin: entry.origin, home: entry.home });
    let consumed = [];
    if (sourceValid) {
      const intention = applyCodexSettingsIntents(entry, candidate.source);
      candidate.source = intention.source; consumed = intention.consumed;
      candidate.view = projectCodexSettings(candidate.source, entry.options);
    }
    if (candidate.conflicts.length) {
      const recovery = path.join(entry.directory, `conflict-${randomUUID()}.toml`);
      durableCodexWrite(recovery, view ?? "", { exclusive: true });
      recovered.push(...candidate.conflicts.map(keys => ({ keys, recovery })));
    }
    const operations = [];
    if (!writable && candidate.source !== (sourceSnapshot ?? "")) {
      // Preserve an edit made before the author changed source permissions.
      // The native view stops accepting writes and the source remains intact.
      const recovery = path.join(entry.directory, `permission-conflict-${randomUUID()}.toml`);
      durableCodexWrite(recovery, candidate.source, { exclusive: true });
      onWarning({ source: entry.origin, keys: [], recovery, reason: "source permissions changed" });
      candidate = { source: sourceSnapshot ?? "", view: sourceValid ? projectCodexSettings(sourceSnapshot ?? "", entry.options) : sourceSnapshot ?? "", conflicts: [] };
    }
    for (const [kind, file, wanted, expected] of [["source", target, candidate.source, sourceSnapshot], ["view", entry.view, candidate.view, viewSnapshot]]) {
      if (expected === wanted || (expected === null && wanted === "" && kind === "source")) continue;
      // The view's directory mode follows source replaceability. AIM must
      // briefly reopen its own directory to publish an authored change.
      if (kind === "view" && (fs.statSync(path.dirname(entry.view)).mode & 0o777) !== 0o700) fs.chmodSync(path.dirname(entry.view), 0o700);
      const staged = path.join(path.dirname(file), `.aim-codex-settings-${randomUUID()}`);
      durableCodexWrite(staged, wanted, { exclusive: true, allowUnreadableParent: kind === "source" });
      // The private journal retains source candidates before publication even
      // if permissions change between staging and exchange.
      operations.push({ kind, target: file, staged, stagedIdentity: identity(staged), expected,
        ...(kind === "source" ? { candidate: wanted } : {}) });
    }
    if (!initial && !pending && !operations.length && !recovered.length && previousRecord === JSON.stringify(state) && state.source === candidate.source && state.view === candidate.view) {
      if (consumed.length) { state.consumedIntents = consumed; atomicRecord(entry.record, state); }
      consumeCodexSettingsIntents(consumed);
      return { entry, raced: false, writable, valid: sourceValid };
    }
    const transaction = { schema: 1, operations };
    atomicRecord(entry.journal, transaction);
    fault("journal");
    let raced = false;
    for (const op of operations) {
      fault(`before-${op.kind}`);
      if (op.expected === null) {
        try { fs.linkSync(op.staged, op.target); }
        catch (e) { if (e.code !== "EEXIST") throw e; raced = true; }
        fs.unlinkSync(op.staged);
        if (!flushParent(op.target, op.kind === "source")) preservePublication(entry, state, op);
      } else {
        const publication = stateIO({ operation: "exchange", target: op.target, staged: op.staged, allowUnreadableParent: op.kind === "source" });
        if (publication.directorySynced === false) preservePublication(entry, state, op);
        const actual = read(op.staged);
        state.retained.push({ path: op.staged, observed: op.expected, kind: op.kind });
        if (actual !== op.expected) raced = true;
      }
      fault(`after-${op.kind}`);
    }
    // A race keeps the old baseline so the displaced delta is still detectable.
    if (!raced) {
      state.source = candidate.source; state.view = candidate.view;
      if (consumed.length) state.consumedIntents = consumed;
    }
    for (const warning of recovered) {
      const key = digest(JSON.stringify([warning.keys, warning.recovery]));
      if (!state.warningKeys.includes(key)) {
        state.warningKeys.push(key);
        onWarning({ source: entry.origin, ...warning, reason: "concurrent settings edit" });
      }
    }
    fault("before-baseline");
    atomicRecord(entry.record, state);
    fault("after-baseline");
    removeRecord(entry.journal);
    if (!raced) consumeCodexSettingsIntents(consumed);
    return { entry, raced, writable, valid: sourceValid };
  } finally {
    try {
      if (sourceReadable) {
        const mode = writable ? 0o700 : 0o500;
        if ((fs.statSync(path.dirname(entry.view)).mode & 0o777) !== mode) fs.chmodSync(path.dirname(entry.view), mode);
      }
    }
    finally { await release(); }
  }
}

export async function superviseCodexSettings(entries, options = {}) {
  let closed = false, running = Promise.resolve(), observed;
  const watchers = [], timers = new Set(), states = new Map();
  // A missed-event fallback only checks the current inputs' metadata. It must
  // not start Python, acquire the source lock or read retained history at idle.
  // Events and explicit flushes still reconcile retained inodes and journals.
  const signature = () => JSON.stringify(entries.map(entry => {
    let target;
    try { target = resolvedTarget(entry.origin); } catch (error) { target = error.code; }
    return [target, ...[entry.origin, path.dirname(entry.origin),
      ...(path.isAbsolute(target ?? "") ? [path.dirname(target)] : []),
      entry.view, path.dirname(entry.view), entry.record, entry.journal,
      path.join(entry.directory, "intents")].map(file => {
      try {
        const st = fs.statSync(file, { bigint: true });
        return [st.dev, st.ino, st.size, st.mode, st.mtimeNs, st.ctimeNs].map(String);
      } catch (error) { return error.code; }
    })];
  }));
  const reconcile = () => {
    const job = running.then(async () => {
      // Remember the pre-read state. A writer racing the transaction must
      // remain detectable on the following fallback check.
      const before = signature();
      for (const entry of entries) {
        let result = await reconcileCodexSettings(entry, options);
        if (result.raced) result = await reconcileCodexSettings(entry, options);
        states.set(entry, result);
      }
      observed = before;
    });
    // A failed flush reports its own error without poisoning final writeback
    // or a subsequent filesystem event's reconciliation.
    running = job.catch(() => {});
    return job;
  };
  await reconcile();
  let scheduled = false;
  const changed = () => {
    if (closed || scheduled) return;
    scheduled = true;
    const timer = setTimeout(() => {
      timers.delete(timer); scheduled = false;
      reconcile().catch(error => options.onError?.(error));
    }, 25);
    timers.add(timer);
  };
  try {
    for (const directory of new Set(entries.flatMap(e => [path.dirname(e.origin), path.dirname(e.view)]))) {
      let watcher;
      try { watcher = fs.watch(directory, changed); }
      catch (error) {
        if (error.code === "EACCES" && entries.some(e => path.dirname(e.origin) === directory)) continue;
        throw error;
      }
      watcher.on("error", error => options.onError?.(error));
      watchers.push(watcher);
    }
  } catch (error) {
    closed = true;
    watchers.forEach(w => w.close());
    for (const timer of timers) clearTimeout(timer);
    throw error;
  }
  const periodic = setInterval(() => { if (signature() !== observed) changed(); }, 1000);
  periodic.unref();
  return { entries, states, flush: reconcile, async close() {
    if (closed) return;
    closed = true; clearInterval(periodic);
    for (const timer of timers) clearTimeout(timer);
    watchers.forEach(w => w.close());
    await reconcile();
  } };
}
