// Finite operations called by mcp_maintenance.py over private pipes. The Python
// owner supplies held lock descriptors; every mutating child inherits them.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeCodexMcpFile, codexMcpTokensEqual } from "./codex-mcp-migration.js";
import { parseCodexSettings, updateCodexSettings } from "../io/codex-settings-toml.js";
import { codexSettingsView, reconcileCodexSettings } from "../io/codex-settings.js";
import { durableCodexWrite } from "../io/codex-state-io.js";
import { codexMcpLockDirectory } from "../privacy/codex-account-state.js";
import { codexCanonicalPath } from "../privacy/codex-launch-inputs.js";
import { readAllRoutineDefinitions } from "../routines/config.js";
import { renderRoutineLaunchAgent, routineLaunchAgentLabel, routineLaunchAgentPath } from "../routines/launchd.js";

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
  return (command, args, { input, allowed = [0], env = process.env } = {}) => {
    // No timeout/kill for a mutating command. Retain the locks until its return.
    const result = spawnSync(command, args, { input, env, stdio, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error || !allowed.includes(result.status)) fail(`MCP maintenance could not complete ${path.basename(command)} (${result.error?.code ?? result.signal ?? result.status}).`);
    return result;
  };
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
const updater = p => nativeOwner(p) && p.args.slice(1, 4).join(" ") === "app-server daemon pid-update-loop"
  && (p.args.length === 4 || (p.args.length === 6 && p.args[4] === "--restore-release"));
const interactiveShell = p => /^(?:zsh|bash|sh|fish|dash)$/.test(imageName(p))
  && p.args.slice(1).every(arg => /^-[il]+$/.test(arg));

export function maintenanceOwners(values, self = process.pid, routineIds = [], retained = []) {
  const byPid = new Map(values.map(p => [p.pid, p]));
  const ancestors = new Set([self]);
  for (let p = byPid.get(self); p && !ancestors.has(p.parent); p = byPid.get(p.parent)) ancestors.add(p.parent);
  const visibleShellLauncher = p => {
    if (!/^(sh|bash|zsh|dash|fish)$/.test(imageName(p))) return false;
    const flag = p.args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
    if (flag < 0) return false;
    const command = p.args[flag + 1] ?? "";
    return /(?:^|[;&|]\s*|\b(?:do|then)\s+)(?:[^\s;&|]*\/)?codex(?:\s|$)/.test(command)
      || /(?:^|[;&|]\s*|\b(?:do|then)\s+)(?:[^\s;&|]*\/)?aim(?:gr)?(?:\.js)?\s+codex\b/.test(command)
      || [...command.matchAll(/\baim(?:gr)?\s+routine\s+run\s+['"]?([a-z0-9-]+)/g)].some(match => routineIds.includes(match[1]));
  };
  if (values.some(p => !ancestors.has(p.pid) && visibleShellLauncher(p))) {
    fail("An external Codex shell launcher is active. Stop its automatic relaunching before one-time MCP maintenance.");
  }
  const remembered = p => retained.some(old => old.pid === p.pid && old.birth === p.birth && old.image === p.image);
  const targets = values.filter(p => nativeOwner(p) || aimOwner(p, routineIds) || nativeWrapper(p) || installer(p) || remembered(p));
  for (const p of targets) {
    if (ancestors.has(p.pid) && nativeOwner(p)) fail("Run one-time MCP maintenance from a terminal outside a running Codex session.");
  }
  const owned = new Map(targets.filter(p => !ancestors.has(p.pid)).map(p => [p.pid, p]));
  // Updater cancellation owns its installer subprocess group. Observe any
  // surviving known installer descendants after stopping that exact updater.
  const updaterIds = new Set([...owned.values()].filter(updater).map(p => p.pid));
  for (const p of values) {
    for (let parent = byPid.get(p.parent), seen = new Set(); parent && !seen.has(parent.pid); parent = byPid.get(parent.parent)) {
      seen.add(parent.pid);
      if (updaterIds.has(parent.pid)) { owned.set(p.pid, p); break; }
    }
  }
  for (const p of owned.values()) {
    const parent = byPid.get(p.parent);
    if (!parent || parent.pid === 1 || ancestors.has(parent.pid) || owned.has(parent.pid) || interactiveShell(parent)) continue;
    // An IDE, desktop agent or unknown supervisor can relaunch a stopped
    // consumer. Discovery is not control; do not proceed by racing it.
    fail("An external Codex launcher is active. Stop its automatic relaunching before one-time MCP maintenance.");
  }
  // macOS hides a protected /bin/sh environment. An orphaned native updater
  // script has only "sh -s" in argv, so absence of its markers is not proof
  // that it is unrelated. Refuse this one-time operation rather than signal
  // an unidentified script or race its later native restart.
  if (values.some(p => imageName(p) === "sh" && p.args.length === 2 && p.args[1] === "-s"
    && p.environment_visible !== true && !owned.has(p.pid))) {
    fail("An unidentified shell installer is still running. Let it finish before one-time MCP maintenance.");
  }
  return [...owned.values()].sort((a, b) => Number(updaterIds.has(b.pid)) - Number(updaterIds.has(a.pid))
    || Number(aimOwner(b, routineIds)) - Number(aimOwner(a, routineIds)));
}

export function maintenanceControllers(values, self, routineIds = [], retained = []) {
  const owners = maintenanceOwners(values, self, routineIds, retained);
  const consumer = p => (nativeOwner(p) && !updater(p)) || aimOwner(p, routineIds) || nativeWrapper(p);
  const allowed = new Set(owners.filter(p => updater(p) || installer(p)
    || retained.some(old => old.pid === p.pid && old.birth === p.birth && old.image === p.image)).map(p => p.pid));
  // A known installer descendant can survive updater cancellation/reparenting.
  // Remember only that exact identity for this finite transaction.
  let changed;
  do {
    changed = false;
    for (const p of owners) if (allowed.has(p.parent) && !allowed.has(p.pid)) { allowed.add(p.pid); changed = true; }
  } while (changed);
  if (owners.some(p => consumer(p) || !allowed.has(p.pid))) fail("Codex sessions or launchers are still running. Let them finish or exit normally, then retry MCP maintenance; no session was stopped.");
  return owners;
}

const identities = owners => owners.map(({ pid, image, birth }) => ({ pid, image, birth }));

const cliFile = fileURLToPath(new URL("../../bin/aimgr.js", import.meta.url));

export function guardedRoutineLauncher(file, launchPath) {
  const real = fs.realpathSync(file);
  const bytes = fs.readFileSync(real, "utf8");
  let interpreter = "node", expectedInterpreter = process.execPath;
  if (real !== fs.realpathSync(cliFile)) {
    // install-local-bin.sh installs a shell wrapper, not a symlink. Recognize
    // only its exact fixed exec shape, and resolve both destinations to this
    // running implementation. Arbitrary scripts named aim are not evidence.
    const match = /^#!\/usr\/bin\/env bash\nset -euo pipefail\nexec "([^"$`\\\r\n]+)" "([^"$`\\\r\n]+)" "\$@"\n$/.exec(bytes);
    if (!match || fs.realpathSync(match[1]) !== fs.realpathSync(process.execPath)
      || fs.realpathSync(match[2]) !== fs.realpathSync(cliFile)) fail("A Codex schedule uses another AIM installation. Update that schedule before MCP conversion.");
    interpreter = "bash";
    expectedInterpreter = "/bin/bash";
  }
  let resolved;
  for (const directory of String(launchPath ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) fail("The Codex schedule has an unreviewed interpreter search path.");
    const candidate = path.join(directory, interpreter);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (!fs.statSync(candidate).isFile()) continue; }
    catch (error) { if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) continue; throw error; }
    resolved = fs.realpathSync(candidate); break;
  }
  if (resolved !== fs.realpathSync(expectedInterpreter)) fail("The Codex schedule resolves a different interpreter before AIM's maintenance check.");
  return { real, sha256: digest(bytes), interpreter: resolved };
}

export function verifyLoadedRoutine(schedule, text) {
  const expected = schedule.definition;
  const field = name => {
    const lines = text.split("\n").filter(line => line.startsWith(`\t${name} = `));
    if (lines.length !== 1) fail("The loaded Codex schedule could not be identified.");
    return lines[0].slice(name.length + 4);
  };
  const block = name => {
    const start = `\t${name} = {\n`, parts = text.split(start);
    if (parts.length !== 2) fail("The loaded Codex schedule could not be identified.");
    const end = parts[1].indexOf("\n\t}");
    if (end < 0) fail("The loaded Codex schedule could not be identified.");
    return parts[1].slice(0, end).split("\n");
  };
  const pairs = lines => Object.fromEntries(lines.map(line => {
    const match = /^\t\t([^\t]+?) => (.*)$/.exec(line);
    if (!match) fail("The loaded Codex schedule environment could not be identified.");
    return match.slice(1);
  }));
  const args = block("arguments").map(line => line.replace(/^\t\t/, ""));
  const env = pairs(block("environment"));
  delete env.OSLogRateLimit;
  if (env.XPC_SERVICE_NAME !== expected.Label) fail("The loaded Codex schedule has a different service identity.");
  delete env.XPC_SERVICE_NAME;
  // Desktop sessions normally inherit SSH_AUTH_SOCK and other ordinary
  // settings. Only startup code injection can bypass the pending check;
  // account/provider settings are read after it. HOME/PATH are verified below.
  for (const name of ["inherited environment", "default environment"]) {
    if (!text.includes(`\t${name} = {\n`)) continue;
    const inherited = pairs(block(name));
    if (Object.keys(inherited).some(key => /^(?:DYLD_|LD_|BASH_FUNC_)/.test(key)
      || ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
        "OPENSSL_CONF", "OPENSSL_CONF_INCLUDE", "OPENSSL_MODULES", "OPENSSL_ENGINES"].includes(key))) {
      fail("The loaded Codex schedule has an inherited startup-code override. Remove that override before MCP conversion.");
    }
  }
  if (canonical(field("path")) !== canonical(schedule.file)
    || field("program") !== expected.ProgramArguments[0]
    || !isDeepStrictEqual(args, expected.ProgramArguments)
    || !isDeepStrictEqual(env, expected.EnvironmentVariables)
    || field("working directory") !== expected.WorkingDirectory
    || field("stdout path") !== expected.StandardOutPath || field("stderr path") !== expected.StandardErrorPath
    || field("properties") !== "inferred program"
    || /^\t(?:run interval|watch paths|queue directories) = /m.test(text)) {
    fail("The loaded Codex schedule differs from AIM's current guarded launcher. Reload that schedule before conversion.");
  }
  const triggers = block("event triggers").join("\n");
  const streams = [...triggers.matchAll(/^\t\t\tstream = (.*)$/gm)].map(match => match[1]);
  const calendars = [...triggers.matchAll(/\t\t\tdescriptor = {\n([\s\S]*?)\n\t\t\t}/g)].map(match => {
    const entries = match[1].split("\n").map(line => /^\t\t\t\t"(Hour|Minute|Weekday)" => (\d+)$/.exec(line));
    if (entries.some(entry => !entry)) fail("The loaded Codex schedule calendar could not be identified.");
    return Object.fromEntries(entries.map(entry => [entry[1], Number(entry[2])]));
  });
  const wanted = [expected.StartCalendarInterval].flat();
  const unmatched = [...wanted];
  const matchingCalendars = calendars.every(calendar => {
    const index = unmatched.findIndex(value => isDeepStrictEqual(value, calendar));
    return index >= 0 && unmatched.splice(index, 1).length === 1;
  });
  if (streams.length !== wanted.length || streams.some(stream => stream !== "com.apple.launchd.calendarinterval")
    || calendars.length !== wanted.length || !matchingCalendars) {
    fail("The loaded Codex schedule has a different calendar. Reload it before conversion.");
  }
}

function loaded(schedule, run) {
  const result = run("/bin/launchctl", ["print", schedule.service], { allowed: [0, 113] });
  if (result.status === 0 && schedule.definition) verifyLoadedRoutine(schedule, result.stdout);
  return result.status === 0;
}

function disabled(schedule, run) {
  const text = run("/bin/launchctl", ["print-disabled", schedule.service.slice(0, schedule.service.lastIndexOf("/"))]).stdout;
  const label = schedule.service.slice(schedule.service.lastIndexOf("/") + 1);
  const value = text.split("\n").map(line => line.trim()).find(line => line.startsWith(`"${label}" => `))?.split("=>")[1].trim();
  if (value !== undefined && !["disabled", "enabled", "true", "false"].includes(value)) fail("Codex schedule enabled state could not be established.");
  return value === "disabled" || value === "true";
}

function schedules(home, run) {
  const routines = readAllRoutineDefinitions({ homeDir: home }).routines.filter(r => r.agent === "codex");
  const codexSchedule = command => /(?:^|[\s/])codex(?:[\s;]|$)/.test(command)
    || [...command.matchAll(/\baim(?:gr)?\s+routine\s+run\s+['"]?([a-z0-9-]+)/g)].some(match => routines.some(r => r.id === match[1]));
  if (process.platform !== "darwin") {
    // AIM has no Linux routine installer. An external scheduler is not owned
    // by this finite conversion; never disable an arbitrary user's service.
    const cron = fs.existsSync("/usr/bin/crontab") ? run("/usr/bin/crontab", ["-l"], { allowed: [0, 1] }).stdout ?? "" : "";
    if (codexSchedule(cron)) fail("An external Codex schedule needs its own pause control before MCP conversion.");
    const systemctl = "/usr/bin/systemctl";
    if (fs.existsSync(systemctl)) {
      const units = run(systemctl, ["--user", "list-units", "--all", "--no-legend", "--plain"], { allowed: [0, 1] });
      const names = (units.stdout ?? "").split("\n").map(line => line.trim().split(/\s+/)[0]).filter(name => /^[A-Za-z0-9@_.:-]+\.service$/.test(name));
      const commands = names.length ? run(systemctl, ["--user", "show", "--property=ExecStart,ExecStartPre,ExecStartPost", ...names]).stdout : "";
      if (codexSchedule(commands)) fail("An external Codex service needs its own pause control before MCP conversion.");
    }
    return [];
  }
  const known = new Map(routines.map(r => [routineLaunchAgentLabel(r.id), r]));
  const result = [];
  for (const directory of [path.join(home, "Library/LaunchAgents"), "/Library/LaunchAgents"]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter(n => n.endsWith(".plist"))) {
      const file = path.join(directory, name), text = fs.readFileSync(file);
      const plist = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]).stdout);
      const args = [plist.Program, ...(plist.ProgramArguments ?? [])].filter(v => typeof v === "string");
      const routine = known.get(plist.Label);
      if (!routine && !args.some(v => /codex|aimgr/.test(v))) continue;
      const schedule = { service: `gui/${process.getuid()}/${plist.Label}`, file, sha256: digest(text), routine };
      if (routine) {
        const command = plist.ProgramArguments;
        if (!Array.isArray(command) || command.length !== 4 || !path.isAbsolute(command[0])
          || command.slice(1).join(" ") !== `routine run ${routine.id}`) fail("A Codex schedule command differs from AIM's reviewed routine launcher.");
        const expected = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
          input: renderRoutineLaunchAgent(routine, { homeDir: home, aimPath: command[0] }),
        }).stdout);
        if (file !== routineLaunchAgentPath({ homeDir: home, routineId: routine.id }) || !isDeepStrictEqual(plist, expected)) {
          fail("A Codex schedule differs from AIM's reviewed calendar-only launcher.");
        }
        schedule.launcher = guardedRoutineLauncher(command[0], expected.EnvironmentVariables.PATH);
        schedule.definition = expected;
      }
      schedule.loaded = loaded(schedule, run);
      schedule.disabled = disabled(schedule, run);
      schedule.enabled = schedule.loaded && !schedule.disabled;
      if (!routine) {
        if (schedule.loaded && args.some(v => /codex/.test(v))) fail("An external Codex LaunchAgent needs its own pause control before MCP conversion.");
        continue;
      }
      if (schedule.loaded && schedule.disabled) fail("A disabled Codex schedule is still loaded and can run. Unload it before one-time MCP conversion.");
      result.push(schedule);
    }
  }
  return result;
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
    // Fail classification before stopping anything. Re-read under native locks
    // for the actual immutable import; this early read is only the scope map.
    const items = decodeCodexMcpFile(read(plan.source_file) ?? "{}", servers);
    plan.routine_ids = readAllRoutineDefinitions({ homeDir: plan.home }).routines.filter(r => r.agent === "codex").map(r => r.id);
    const owners = maintenanceControllers(processInventory(plan.process_control, run), process.pid, plan.routine_ids);
    const lockDirectories = [...new Set([canonical(path.join(source, "mcp-oauth-locks")),
      codexCanonicalPath(codexMcpLockDirectory(plan.home))])].sort();
    return { ...plan, servers, controllers: identities(owners), schedules: schedules(plan.home, run),
      original_store_setting: parseCodexSettings(read(path.join(source, "config.toml")) ?? "").value.mcp_oauth_credentials_store ?? null,
      lock_directories: [...new Set(lockDirectories)],
      refresh_locks: [...new Set(lockDirectories.flatMap(dir => items.map(item => path.join(dir, `${digest(item.key)}.lock`))))].sort(),
      file_lock: path.join(canonical(path.join(source, "mcp-oauth-locks")), "file-store.lock") };
  }
  if (request.operation === "pause" || request.operation === "restore") {
    const schedule = request.schedule;
    if (!schedule.enabled) return {};
    if (digest(fs.readFileSync(schedule.file)) !== schedule.sha256) fail("A paused Codex schedule changed; its new definition was preserved.");
    if (!isDeepStrictEqual(guardedRoutineLauncher(schedule.definition.ProgramArguments[0], schedule.definition.EnvironmentVariables.PATH), schedule.launcher)) fail("The paused Codex schedule's AIM launcher changed; its new installation was preserved.");
    loaded(schedule, run); // Verify the effective loaded definition before disable or bootout.
    const wantDisabled = request.operation === "pause";
    if (wantDisabled) {
      if (!disabled(schedule, run)) run("/bin/launchctl", ["disable", schedule.service]);
      // disable alone does not stop an already loaded calendar job. Pending is
      // checked before current AIM account selection and again at vendor exec;
      // refuse any older/live consumer before bootout can signal the service.
      const plan = request.plan;
      maintenanceControllers(processInventory(plan.process_control, run), process.pid, plan.routine_ids, plan.controllers);
      if (loaded(schedule, run)) run("/bin/launchctl", ["bootout", schedule.service]);
      if (loaded(schedule, run) || !disabled(schedule, run)) fail("Codex schedule pause could not be verified.");
    } else {
      if (disabled(schedule, run)) run("/bin/launchctl", ["enable", schedule.service]);
      if (!loaded(schedule, run)) run("/bin/launchctl", ["bootstrap", schedule.service.slice(0, schedule.service.lastIndexOf("/")), schedule.file]);
      if (!loaded(schedule, run) || disabled(schedule, run)) fail("Codex schedule restoration could not be verified.");
    }
    return {};
  }
  const plan = request.plan;
  if (request.operation === "recheck") {
    const owners = maintenanceControllers(processInventory(plan.process_control, run), process.pid, plan.routine_ids, plan.controllers);
    return { ...plan, controllers: identities(owners) };
  }
  if (request.operation === "stop") {
    const owners = maintenanceControllers(processInventory(request.process_control, run), process.pid, plan.routine_ids, plan.controllers);
    const retained = identities(owners);
    if (retained.some(p => !plan.controllers.some(old => old.pid === p.pid && old.birth === p.birth && old.image === p.image))) {
      fail("The native updater changed during maintenance inventory. Retry explicit recovery before stopping it.");
    }
    for (const owner of owners) {
      const current = maintenanceControllers(processInventory(request.process_control, run), process.pid, plan.routine_ids, retained);
      if (current.some(p => !retained.some(old => old.pid === p.pid && old.birth === p.birth && old.image === p.image))) {
        fail("A new updater child needs a durable inventory. Retry explicit recovery before stopping it.");
      }
      run(request.process_control, [String(owner.pid), owner.image, owner.birth]);
    }
    if (maintenanceControllers(processInventory(request.process_control, run), process.pid, plan.routine_ids, retained).length) fail("A Codex launcher relaunched during maintenance. Conversion remains pending.");
    return {};
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
