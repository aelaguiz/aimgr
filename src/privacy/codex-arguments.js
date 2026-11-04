import path from "node:path";

const VALUES = new Map([
  ["-c", "config"], ["--config", "config"], ["-p", "profile"], ["--profile", "profile"],
  ["-C", "cwd"], ["--cd", "cwd"], ["--add-dir", "directory"], ["-i", "image"], ["--image", "image"],
  ["-m", "model"], ["--model", "model"], ["-s", "sandbox"], ["--sandbox", "sandbox"],
  ["-a", "approval"], ["--ask-for-approval", "approval"], ["--local-provider", "provider"],
  ["--cloud-skills-snapshot", "input"], ["--output-schema", "input"],
  ["-o", "output"], ["--output-last-message", "output"],
  ...["--enable", "--disable", "--thread-source", "--cyber-access-program",
    "--color", "--listen", "--remote", "--remote-auth", "--exec-server"].map(k => [k, "value"]),
]);
const WORKTREE_FLAGS = new Set(["--no-daemon", "--worktree", "--help", "-h", "--version", "-V", "--strict-config",
  "--last", "--all", "--include-non-interactive", "--yolo", "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust", "--approve-for-me", "--not-so-yolo", "--search", "--oss", "--no-alt-screen",
  "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json", "--experimental-json"]);
const EXEC_ONLY = new Set(["--thread-source", "--cyber-access-program", "--skip-git-repo-check", "--ephemeral",
  "--ignore-user-config", "--ignore-rules", "--output-schema", "--color", "--json", "--experimental-json", "-o", "--output-last-message"]);
const TUI_ONLY = new Set(["-a", "--ask-for-approval", "--search", "--no-alt-screen", "--no-daemon"]);
const EXEC_GLOBAL = new Set(["-c", "--config", "--enable", "--disable", "-m", "--model", "-i", "--image",
  "--yolo", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--worktree",
  "--strict-config", ...[...EXEC_ONLY].filter(key => key !== "--color"), "--help", "-h", "--version", "-V"]);
const COMMANDS = new Set(["agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug", "execpolicy", "apply", "a", "resume", "queue", "archive", "delete", "migrate-rollouts", "migrate-nfs-db", "unarchive", "fork", "cloud", "cloud-tasks", "responses-api-proxy", "stdio-to-uds", "exec-server", "features", "tcp-tunnel"]);
const UNSUPPORTED = new Set(["agents", "remote-control", "app", "update", "responses-api-proxy", "stdio-to-uds", "exec-server", "tcp-tunnel", "queue"]);

/** Inspect the pinned public CLI grammar without treating prompt contents as
 * commands. Keep arguments and values byte-for-byte except the standalone pin. */
export function codexArguments(args, { cwd = process.cwd(), ownedAppServer = false } = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("Codex arguments must be strings.");
  let command = null, profile = null, directory = cwd, index = -1, prompt = false, noDaemon = false, listen = null;
  const directories = [], images = [], config = [], files = [], outputs = [], rawDirectories = [], harness = {}, enabled = [], disabled = [];
  const unknownOptions = [], optionFacts = [];
  let yolo = false, worktree = false, cwdOverride = null, strictConfig = false, ignoreUserConfig = false, ignoreRules = false;
  let approveForMe = false, rootApproveForMe = false, childPermissions = false, childImages = false;
  let search = false, oss = false, localProvider = null;
  const positionals = [], positionalIndices = [], optionSpans = [], worktreeIndices = [];
  let inspection = false, last = false, all = false, execSubcommand = null;
  for (let i = 0; i < args.length; i++) {
    const start = i;
    const arg = args[i];
    if (arg === "--") {
      if (command) for (let j = i + 1; j < args.length; j++) { positionals.push(args[j]); positionalIndices.push(j); }
      break;
    }
    if (arg === "--no-daemon") noDaemon = true;
    let key = arg, value;
    if (arg.startsWith("--") && arg.includes("=")) { key = arg.slice(0, arg.indexOf("=")); value = arg.slice(arg.indexOf("=") + 1); }
    else if (/^-[cpCimsao].+/.test(arg)) { key = arg.slice(0, 2); value = arg.slice(2).replace(/^=/, ""); }
    if (arg.startsWith("-") && arg !== "-") optionFacts.push({ key, command, execSubcommand });
    if (["--remote", "--remote-auth", "--remote-auth-token-env", "--exec-server", "--code-mode-host", "--remote-control", "--managed-daemon", "--analytics-default-enabled"].includes(key)) throw new Error("AIM Codex does not attach to a remote or shared background server.");
    const permissionChoice = ["--yolo", "--dangerously-bypass-approvals-and-sandbox", "--approve-for-me", "--not-so-yolo", "--sandbox", "-s"].includes(key);
    if (command && !childPermissions && permissionChoice) {
      // Native chooses this permission group at the selected command level;
      // a child sandbox selection must not inherit a root --yolo switch.
      childPermissions = true; yolo = false; approveForMe = false; delete harness.sandbox;
    }
    if (["resume", "fork"].includes(command) && ["--yolo", "--dangerously-bypass-approvals-and-sandbox", "--approve-for-me", "--not-so-yolo"].includes(key)) delete harness.approval;
    if (["--yolo", "--dangerously-bypass-approvals-and-sandbox"].includes(key)) yolo = true;
    if (key === "--ephemeral") harness.ephemeral = true;
    if (key === "--worktree") { worktree = true; worktreeIndices.push(i); }
    if (["--help", "-h", "--version", "-V"].includes(key) || /^-[hV]+$/.test(arg)) inspection = true;
    if (key === "--last") last = true;
    if (key === "--all") all = true;
    if (key === "--strict-config") strictConfig = true;
    if (key === "--ignore-user-config") ignoreUserConfig = true;
    if (key === "--ignore-rules") ignoreRules = true;
    if (key === "--dangerously-bypass-hook-trust") harness.bypass_hook_trust = true;
    if (["--approve-for-me", "--not-so-yolo"].includes(key)) approveForMe = true;
    if (key === "--search") search = true;
    if (key === "--oss") oss = true;
    const kind = VALUES.get(key);
    if (kind) {
      value ??= args[++i];
      if (value === undefined) throw new Error(`Codex option ${key} needs a value.`);
      if (kind === "profile") profile = value;
      if (kind === "cwd") directory = cwdOverride = path.resolve(cwd, value);
      if (kind === "directory") rawDirectories.push(value);
      if (kind === "input") files.push(path.resolve(cwd, value));
      if (kind === "output") outputs.push(path.resolve(cwd, value));
      if (["model", "sandbox", "approval"].includes(kind)) harness[kind] = value;
      if (kind === "provider") localProvider = value;
      if (key === "--enable") enabled.push(value);
      if (key === "--disable") disabled.push(value);
      if (kind === "image") {
        if (["resume", "fork"].includes(command) && !childImages) { images.length = 0; childImages = true; }
        images.push(...value.split(",").map(v => path.resolve(cwd, v)));
        // clap's root/TUI and exec image options consume one or more values.
        // exec resume/fork narrow this to one value. Preserve that distinction
        // so an image named after a command is still an image.
        if (!(["exec", "e"].includes(command) && ["resume", "fork"].includes(execSubcommand))) {
          while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
            images.push(...args[++i].split(",").map(v => path.resolve(cwd, v)));
          }
        }
      }
      if (kind === "config") config.push(value);
      if (key === "--listen") listen = value;
      optionSpans.push({ key, kind, start, end: i + 1 });
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (!WORKTREE_FLAGS.has(key) || value !== undefined) unknownOptions.push(arg);
      continue;
    }
    if (command) {
      if (["exec", "e"].includes(command) && !positionals.length && ["resume", "fork", "review"].includes(arg)) execSubcommand = arg;
      positionals.push(arg); positionalIndices.push(i);
    }
    else if (!prompt && COMMANDS.has(arg)) {
      command = arg; index = i;
      rootApproveForMe = approveForMe; approveForMe = false;
    }
    else prompt = true;
  }
  if (UNSUPPORTED.has(command)) throw new Error(`AIM Codex does not start the ${command} entry point.`);
  if (command === "login" && positionals[0] !== "status") throw new Error("Use `aim codex login <label>` for this machine's manual authorization.");
  if (command === "logout") throw new Error("Use `aim codex logout <label>` to clear this machine's authorization.");
  if (command === "app-server" && (!ownedAppServer || positionals.length || (listen !== null && listen !== "stdio://"))) throw new Error("AIM only starts an invocation-owned stdio app server.");
  if (command === "debug" && positionals[0] === "app-server") throw new Error("AIM does not start the native shared app-server debug client.");
  if (profile !== null && !/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error("Invalid Codex profile name.");
  const standalone = command === null || command === "resume" || command === "fork";
  config.push(...enabled.map(name => `features.${name}=true`), ...disabled.map(name => `features.${name}=false`));
  if (rootApproveForMe) config.push('approvals_reviewer="auto_review"', 'approval_policy="on-request"', 'sandbox_mode="workspace-write"');
  if (approveForMe && command !== "app-server") config.push('approvals_reviewer="auto_review"', 'approval_policy="on-request"', 'sandbox_mode="workspace-write"');
  if (search && standalone) config.push('web_search="live"');
  if (oss && localProvider) harness.model_provider = localProvider;
  // Native resolves additive roots against -C, except --worktree which saves
  // their meaning against the original cwd before it creates the new worktree.
  for (const value of rawDirectories) directories.push(path.resolve(worktree ? cwd : directory, value));
  harness.additional_writable_roots = [...directories];
  if (yolo) { harness.sandbox = "danger-full-access"; harness.approval = "never"; }
  if (["exec", "e", "review"].includes(command)) harness.approval = "never";
  // The native app-server entry consumes root config overrides but not TUI
  // profile/cwd/model/permission flags.
  if (command === "app-server") { profile = null; directory = cwd; }
  return { args: standalone && !noDaemon ? ["--no-daemon", ...args] : [...args],
    command, commandIndex: index, profile, cwd: directory, cwdOverride, processCwd: cwd, directories, images, files, outputs, config,
    strictConfig, ignoreUserConfig, ignoreRules, yolo, worktree, oss, localProvider,
    originalArgs: [...args], positionals, positionalIndices, optionSpans, worktreeIndices, inspection, last, all, execSubcommand, unknownOptions, optionFacts,
    harness: command === "app-server" ? {} : harness };
}

/** Preserve native eligibility before doing the explicitly requested Git work. */
export function validateCodexWorktreeArguments(parsed) {
  if (!parsed.worktree || parsed.inspection) return false;
  if (parsed.unknownOptions.length) throw new Error("Codex --worktree received an unsupported native option; no checkout was created.");
  const exec = ["exec", "e"].includes(parsed.command);
  for (const option of parsed.optionFacts) {
    const inExec = ["exec", "e"].includes(option.command);
    if ((!inExec && EXEC_ONLY.has(option.key)) || (inExec && TUI_ONLY.has(option.key))
      || (option.execSubcommand && !EXEC_GLOBAL.has(option.key))
      || ["--cloud-skills-snapshot", "--listen"].includes(option.key)) {
      throw new Error("Codex --worktree received an option outside its native command scope; no checkout was created.");
    }
  }
  if (parsed.execSubcommand === "fork" && parsed.optionFacts.some(option => option.key === "--cyber-access-program")
    && parsed.positionals.length < 3) throw new Error("Codex worktree fork with --cyber-access-program requires a prompt; no checkout was created.");
  if (exec && (parsed.harness.ephemeral || parsed.ignoreUserConfig)) {
    throw new Error("Codex --worktree cannot be combined with --ephemeral or --ignore-user-config.");
  }
  const explicitFork = parsed.command === "fork" && parsed.positionals.length && !parsed.last;
  const execNewOrFork = exec && !["resume", "review"].includes(parsed.execSubcommand);
  if (!(parsed.command === null || explicitFork || execNewOrFork)) {
    throw new Error("Codex --worktree requires a new session or an explicit fork.");
  }
  return true;
}

/** Native process cwd stays unchanged; only path choices whose meaning changes
 * when removing --worktree are replaced. Escaped prompt text is untouched. */
export function codexWorktreeArguments(parsed, destination, forkId = null) {
  if (!path.isAbsolute(destination)) throw new Error("Codex worktree destination must be absolute.");
  const removed = new Set(parsed.worktreeIndices);
  for (const span of parsed.optionSpans) if (["cwd", "directory"].includes(span.kind)) {
    for (let i = span.start; i < span.end; i++) removed.add(i);
  }
  const forkIndex = parsed.command === "fork" ? parsed.positionalIndices[0]
    : ["exec", "e"].includes(parsed.command) && parsed.execSubcommand === "fork" ? parsed.positionalIndices[1] : null;
  const args = parsed.originalArgs.flatMap((value, i) => removed.has(i) ? [] : [forkId && i === forkIndex ? forkId : value]);
  return codexArguments(["-C", destination, ...parsed.directories.flatMap(dir => ["--add-dir", dir]), ...args], {
    cwd: parsed.processCwd,
  });
}
