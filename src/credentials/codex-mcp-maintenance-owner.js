// Finite operations called by mcp_maintenance.py over private pipes. The Python
// owner supplies held lock descriptors; every mutating child inherits them.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { admitCodexArtifact } from "../privacy/codex-artifacts.js";
import { stageLaunchEnvironment } from "../privacy/launch-environment.js";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeCodexMcpFile, codexMcpTokensEqual } from "./codex-mcp-migration.js";
import { parseCodexSettings, updateCodexSettings } from "../io/codex-settings-toml.js";
import { codexSettingsView, reconcileCodexSettings } from "../io/codex-settings.js";
import { durableCodexWrite } from "../io/codex-state-io.js";
import { codexMcpLockDirectory } from "../privacy/codex-account-state.js";
import { codexCanonicalPath } from "../privacy/codex-launch-inputs.js";
import { readAllRoutineDefinitions } from "../routines/config.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const fail = message => { const error = new Error(message); error.maintenance = true; throw error; };
const canonical = file => fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
const read = file => { try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };

export function maintenanceCommands(lockFds = []) {
  if (!Array.isArray(lockFds) || !lockFds.length || lockFds.some(fd => !Number.isInteger(fd) || fd < 3 || fd > 4096)) fail("Maintenance requires its inherited control lock.");
  // The restricted native reader requires all three channels to be private
  // pipes. Capture stderr for that boundary, but never include it in errors.
  const stdio = ["pipe", "pipe", "pipe"];
  for (const fd of lockFds) { fs.fstatSync(fd); while (stdio.length <= fd) stdio.push("ignore"); stdio[fd] = fd; }
  return (command, args, { input, allowed = [0], env = process.env, passFds = [] } = {}) => {
    const childStdio = [...stdio];
    for (const fd of passFds) { fs.fstatSync(fd); while (childStdio.length <= fd) childStdio.push("ignore"); childStdio[fd] = fd; }
    // No timeout/kill for a mutating command. Retain the locks until its return.
    const result = spawnSync(command, args, { input, env, stdio: childStdio, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error || !allowed.includes(result.status)) fail(`MCP maintenance could not complete ${path.basename(command)} (${result.error?.code ?? result.signal ?? result.status}).`);
    return result;
  };
}

/** Codex exits zero even when Keychain denies access. Only its native OAuth
 * status for every imported identity establishes that conversion can commit.
 * A readable expired credential can require login; it must not block all other
 * integrations. This fixed network-denied command cannot discover a login. */
export function assertNativeMcpRead(entries, items) {
  if (!Array.isArray(entries)
    || new Set(entries.map(entry => entry?.name)).size !== entries.length
    || items.some(item => !entries.some(entry => entry?.name === item.serverName
      && entry.transport?.type === "streamable_http" && entry.transport.url === item.url
      && ["o_auth", "not_logged_in"].includes(entry.auth_status)))) {
    fail("Codex could not read every imported MCP credential. In the macOS Keychain prompt choose Always Allow, then run aim codex mcp-recover. The original File credentials remain preserved.");
  }
}

function nativeRead(plan, items, run) {
  if (process.platform !== "darwin" || !plan.native_access) fail("Native Keychain verification requires macOS.");
  const artifact = admitCodexArtifact({ pinnedArtifactSet: plan.artifact_set });
  if (artifact.command !== plan.native_access.executable || artifact.vendorSha256 !== plan.native_access.sha256) {
    fail("The admitted Codex changed during MCP conversion. The original credentials remain preserved.");
  }
  let root, scratch, environmentFd;
  try {
    root = fs.mkdtempSync(`/opt/aimgr-codex-runtime/users/${process.getuid()}/maintenance/read-`);
    const home = path.join(root, "home"); fs.mkdirSync(home, { mode: 0o700 });
    const config = ['mcp_oauth_credentials_store="keyring"', '[features]', 'secret_auth_storage=false',
      ...items.flatMap(item => [`[mcp_servers.${JSON.stringify(item.serverName)}]`, `url=${JSON.stringify(item.url)}`])].join("\n") + "\n";
    fs.writeFileSync(path.join(home, "config.toml"), config, { mode: 0o600, flag: "wx" });
    scratch = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), `aim-codex-${process.getuid()}-`));
    fs.chmodSync(scratch, 0o700);
    environmentFd = stageLaunchEnvironment({ HOME: os.userInfo().homedir, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, scratch);
    const result = run(artifact.launcher, ["mcp-verify-v1", root, home, scratch, String(environmentFd),
      "0", "0", "0", "0", "--"], { env: { PATH: "/usr/bin:/bin" }, passFds: [environmentFd] });
    let entries; try { entries = JSON.parse(result.stdout); } catch { /* fixed error below */ }
    assertNativeMcpRead(entries, items);
  } finally {
    if (environmentFd !== undefined) fs.closeSync(environmentFd);
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
}

function nativeInputs(plan, run, values = []) {
  const input = { operation: "mcp_inputs", artifact_set: plan.artifact_set, codex_home: plan.source_home,
    cwd: plan.cwd, config: [], mcp_values: values,
    forced_config: plan.managed.forced?.config_toml_base64 ?? "",
    forced_requirements: plan.managed.forced?.requirements_toml_base64 ?? "" };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("LD_") && !key.startsWith("DYLD_") && key !== "GLIBC_TUNABLES"));
  const value = JSON.parse(run(plan.config_state, [], { input: JSON.stringify(input), env }).stdout);
  if (value.schema !== 1 || value.source_revision !== "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856"
    || !Array.isArray(value.mcp_servers) || value.mcp_keyring_backend !== "direct") {
    fail("MCP conversion requires the existing ordinary Direct keyring backend and reviewed native configuration.");
  }
  return value;
}

function processInventory(helper, run) {
  const values = JSON.parse(run(helper, ["--inventory"]).stdout);
  if (!Array.isArray(values) || values.some(p => !Number.isInteger(p.pid) || !Number.isInteger(p.parent)
    || !path.isAbsolute(p.image) || typeof p.birth !== "string" || !Array.isArray(p.args))) fail("Cannot establish the native process inventory.");
  return values;
}

const imageName = p => path.basename(p.image.replace(/ \(deleted\)$/, ""));
const nativeOwner = p => /^(codex|codex-code-mode-host)(?:[-.].*)?$/.test(imageName(p))
  && !imageName(p).endsWith(".js");
const aimOwner = (p, routineIds) => p.args.some(arg => /(?:^|\/)aim(?:gr)?(?:\.js)?$/.test(arg) || /\/aimgr(?:-[^/]+)?\/(?:src\/cli\.js|bin\/aim(?:gr)?\.js)$/.test(arg))
  && (p.args.includes("codex") || (p.args.includes("routine") && ["run", "__execute"].includes(p.args[p.args.indexOf("routine") + 1])
    && routineIds.includes(p.args[p.args.indexOf("routine") + 2])));
const nativeWrapper = p => p.args.some(arg => /\/(?:@openai\/codex\/bin\/codex\.js|codex\/bin\/codex(?:\.js)?)$/.test(arg));
const installer = p => p.native_installer === true;
/** Conversion needs existing token consumers to finish. It does not control
 * their launchers, schedules or unrelated processes. New AIM admissions use
 * the existing maintenance marker; raw launches outside AIM are out of scope. */
export function assertNoCodexConsumers(values, self = process.pid, routineIds = []) {
  const byPid = new Map(values.map(p => [p.pid, p]));
  const ancestors = new Set([self]);
  for (let p = byPid.get(self); p && !ancestors.has(p.parent); p = byPid.get(p.parent)) ancestors.add(p.parent);
  if (values.some(p => ancestors.has(p.pid) && nativeOwner(p))) {
    fail("Run one-time MCP maintenance from a terminal outside a running Codex session.");
  }
  if (values.some(p => !ancestors.has(p.pid) && (nativeOwner(p) || aimOwner(p, routineIds) || nativeWrapper(p) || installer(p)))) {
    fail("Codex sessions, launchers or updaters are still running. Let them finish or exit normally, then retry MCP maintenance; no process was stopped.");
  }
}

async function publish(plan, run) {
  const source = path.join(plan.source_home, "config.toml");
  const current = parseCodexSettings(read(source) ?? "").value.mcp_oauth_credentials_store ?? null;
  if (current !== plan.original_store_setting && current !== "keyring") fail("The MCP backend setting changed during conversion. Its authored value was preserved.");
  const entry = codexSettingsView({ base: path.join(plan.home, ".aimgr"), source, home: plan.home });
  const stateIO = request => {
    const result = JSON.parse(run("/usr/bin/python3", ["-I", plan.state_io], { input: JSON.stringify(request) }).stdout);
    if (result.error) fail("MCP conversion could not persist the shared settings change.");
    return result;
  };
  await reconcileCodexSettings(entry, { stateIO });
  const value = updateCodexSettings(read(entry.view) ?? "", [{ keys: ["mcp_oauth_credentials_store"], value: "keyring" }]);
  const staged = `${entry.view}.maintenance-${randomUUID()}`;
  durableCodexWrite(staged, value, { exclusive: true });
  fs.renameSync(staged, entry.view);
  const fd = fs.openSync(path.dirname(entry.view), "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  await reconcileCodexSettings(entry, { stateIO });
  if (nativeInputs(plan, run).mcp_store !== "keyring") fail("A native settings layer still selects a different MCP store. Conversion remains pending.");
}

export async function maintenanceOperation(request) {
  const run = maintenanceCommands(request.lock_fds);
  if (request.operation === "plan") {
    const source = canonical(request.source_home);
    const plan = { source_home: source, source_file: path.join(source, ".credentials.json"),
      cwd: request.cwd, home: request.home, config_state: request.config_state, state_io: request.state_io,
      artifact_set: request.artifact_set, managed: request.managed, process_control: request.process_control };
    if (process.platform === "darwin") {
      if (!path.isAbsolute(request.native_access?.executable ?? "") || !/^[a-f0-9]{64}$/.test(request.native_access?.sha256 ?? "")) fail("MCP migration needs the admitted native keychain application identity.");
      plan.native_access = request.native_access;
    }
    const input = nativeInputs(plan, run);
    const servers = input.mcp_servers.filter(s => s.environment_id === "local" && s.ordinary_oauth);
    // Fail classification before publishing pending maintenance. Re-read under native locks
    // for the actual immutable import; this early read is only the scope map.
    const items = decodeCodexMcpFile(read(plan.source_file) ?? "{}", servers);
    plan.routine_ids = readAllRoutineDefinitions({ homeDir: plan.home }).routines.filter(r => r.agent === "codex").map(r => r.id);
    assertNoCodexConsumers(processInventory(plan.process_control, run), process.pid, plan.routine_ids);
    const lockDirectories = [...new Set([canonical(path.join(source, "mcp-oauth-locks")),
      codexCanonicalPath(codexMcpLockDirectory(plan.home))])].sort();
    return { ...plan, servers,
      original_store_setting: parseCodexSettings(read(path.join(source, "config.toml")) ?? "").value.mcp_oauth_credentials_store ?? null,
      lock_directories: [...new Set(lockDirectories)],
      refresh_locks: [...new Set(lockDirectories.flatMap(dir => items.map(item => path.join(dir, `${digest(item.key)}.lock`))))].sort(),
      file_lock: path.join(canonical(path.join(source, "mcp-oauth-locks")), "file-store.lock") };
  }
  const plan = request.plan;
  if (request.operation === "recheck") {
    assertNoCodexConsumers(processInventory(plan.process_control, run), process.pid, plan.routine_ids);
    return plan;
  }
  if (request.operation === "intent") {
    const items = decodeCodexMcpFile(request.file, nativeInputs(plan, run).mcp_servers.filter(s => s.environment_id === "local" && s.ordinary_oauth));
    const known = new Set(plan.refresh_locks);
    if (plan.lock_directories.some(dir => items.some(item => !known.has(path.join(dir, `${digest(item.key)}.lock`))))) fail("MCP credentials changed after the maintenance inventory. Conversion remains pending.");
    return { items: items.map(item => ({ serverName: item.serverName, url: item.url, value: JSON.stringify(item.token) })) };
  }
  if (request.operation === "destination") {
    if (request.existing === null) return { value: request.item.value };
    if (!codexMcpTokensEqual(JSON.parse(request.existing), JSON.parse(request.item.value))) fail("The native keyring contains a different credential. Both versions were preserved.");
    return { value: request.existing };
  }
  if (request.operation === "native-read") { nativeRead(plan, request.items, run); return {}; }
  if (request.operation === "publish") { await publish(plan, run); return {}; }
  if (request.operation === "validate") { nativeInputs(plan, run, [request.value]); return {}; }
  if (request.operation === "verify") {
    if (nativeInputs(plan, run, request.values ?? []).mcp_store !== "keyring" || fs.existsSync(plan.source_file)) fail("MCP conversion has not completed its native readback and File retirement.");
    return {};
  }
  fail("Unknown MCP maintenance operation.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = fs.readFileSync(0, "utf8");
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) fail("Maintenance input exceeds its supported size.");
    process.stdout.write(JSON.stringify(await maintenanceOperation(JSON.parse(input))) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.maintenance ? error.message : "MCP maintenance could not validate its private configuration or owner state." }) + "\n");
    process.exitCode = 1;
  }
}
