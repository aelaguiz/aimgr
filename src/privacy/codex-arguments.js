import path from "node:path";

const VALUES = new Map([
  ["-c", "config"], ["--config", "config"], ["-p", "profile"], ["--profile", "profile"],
  ["-C", "cwd"], ["--cd", "cwd"], ["--add-dir", "directory"], ["-i", "image"], ["--image", "image"],
  ...["-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "--local-provider", "--enable", "--disable",
    "--color", "--output-schema", "-o", "--output-last-message", "--listen", "--remote", "--remote-auth", "--exec-server"].map(k => [k, "value"]),
]);
const COMMANDS = new Set(["agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug", "execpolicy", "apply", "a", "resume", "queue", "archive", "delete", "migrate-rollouts", "migrate-nfs-db", "unarchive", "fork", "cloud", "cloud-tasks", "responses-api-proxy", "stdio-to-uds", "exec-server", "features", "tcp-tunnel"]);
const UNSUPPORTED = new Set(["agents", "remote-control", "app", "update", "responses-api-proxy", "stdio-to-uds", "exec-server", "tcp-tunnel", "queue"]);

/** Inspect the pinned public CLI grammar without treating prompt contents as
 * commands. Keep arguments and values byte-for-byte except the standalone pin. */
export function codexArguments(args, { cwd = process.cwd(), ownedAppServer = false } = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("Codex arguments must be strings.");
  let command = null, profile = null, directory = cwd, index = -1, prompt = false, noDaemon = false, listen = null;
  const directories = [], images = [], config = [];
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "--no-daemon") noDaemon = true;
    let key = arg, value;
    if (arg.startsWith("--") && arg.includes("=")) { key = arg.slice(0, arg.indexOf("=")); value = arg.slice(arg.indexOf("=") + 1); }
    else if (/^-[cpCimsao].+/.test(arg)) { key = arg.slice(0, 2); value = arg.slice(2).replace(/^=/, ""); }
    if (["--remote", "--remote-auth", "--exec-server", "--remote-control", "--managed-daemon", "--analytics-default-enabled"].includes(key)) throw new Error("AIM Codex does not attach to a remote or shared background server.");
    const kind = VALUES.get(key);
    if (kind) {
      value ??= args[++i];
      if (value === undefined) throw new Error(`Codex option ${key} needs a value.`);
      if (kind === "profile") profile = value;
      if (kind === "cwd") directory = path.resolve(cwd, value);
      if (kind === "directory") directories.push(path.resolve(cwd, value));
      if (kind === "image") {
        images.push(...value.split(",").map(v => path.resolve(cwd, v)));
        // clap's root/TUI and exec image options consume one or more values.
        // exec resume/fork narrow this to one value. Preserve that distinction
        // so an image named after a command is still an image.
        if (!(["exec", "e"].includes(command) && ["resume", "fork"].includes(positionals[0]))) {
          while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
            images.push(...args[++i].split(",").map(v => path.resolve(cwd, v)));
          }
        }
      }
      if (kind === "config") config.push(value);
      if (key === "--listen") listen = value;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (command) positionals.push(arg);
    else if (!prompt && COMMANDS.has(arg)) { command = arg; index = i; }
    else prompt = true;
  }
  if (UNSUPPORTED.has(command)) throw new Error(`AIM Codex does not start the ${command} entry point.`);
  if (command === "login" && positionals[0] !== "status") throw new Error("Use `aim codex login <label>` for this machine's manual authorization.");
  if (command === "logout") throw new Error("Use `aim codex logout <label>` to clear this machine's authorization.");
  if (command === "app-server" && (!ownedAppServer || positionals.length || (listen !== null && listen !== "stdio://"))) throw new Error("AIM only starts an invocation-owned stdio app server.");
  if (command === "debug" && positionals[0] === "app-server") throw new Error("AIM does not start the native shared app-server debug client.");
  if (profile !== null && !/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error("Invalid Codex profile name.");
  const standalone = command === null || command === "resume" || command === "fork";
  return { args: standalone && !noDaemon ? ["--no-daemon", ...args] : [...args],
    command, commandIndex: index, profile, cwd: directory, directories, images, config };
}
