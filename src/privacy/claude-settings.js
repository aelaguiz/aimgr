import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Match the reviewed client's 2 MiB file bound. A smaller wrapper limit would
// reject settings that already work in vanilla Claude (T15 compatibility).
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const REQUIRED_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
// Audited 2.1.316 eager argument-reader grammar. Required values may themselves equal
// "--settings" (for example an appended prompt); never consume them as options.
// Re-audit with the pinned binary on upgrades. Optional/variadic later values
// stop at a new option, so they need no extra consumption here.
const REQUIRED_VALUE_FLAGS = new Set(`
--add-dir --advisor --agent --agent-color --agent-id --agent-name --agent-type
--agents --allowedTools --allowed-tools --append-subagent-system-prompt
--append-subagent-system-prompt-file --append-system-prompt --append-system-prompt-file
--attach-serve --autocompact --betas --channels --client-data-url --correlation-id
--dangerously-load-development-channels --debug-file --deep-link-cwd-b64
--deep-link-last-fetch --deep-link-repo --disallowedTools --disallowed-tools --effort
--environment --fallback-model --fast-mode --file --forward-home-settings
--routine --handle-uri --exec -m
--inherit-permission-mode --input-format --json-schema --managed-settings
--max-budget-usd --max-thinking-tokens --max-turns --mcp-config --messaging-socket-path
--model --on-branch --output-format --parent-session-id --permission-mode
--permission-prompt-tool --permission-prompts --plan-mode-instructions --plugin-dir
--plugin-dir-no-mcp --plugin-url --pool --prefill --prefill-b64 --proactivity
--project-config-root --ref --remote-control-session-name-prefix --resume-drops-turn
--resume-session-at --rewind-files --runner-declares --sdk-url --session-began-as-copy
--session-id --setting-sources --system-prompt --system-prompt-file
--system-prompt-snapshot --task-budget --team-name --teammate-mode --thinking
--thinking-display --tools --watch-artifact --watch-artifact-no-autoreact --workload
-n --name
`.trim().split(/\s+/));

export class ClaudePrivacySettingsError extends Error {
  constructor(reason) {
    // Settings can contain credentials. Never include JSON, parser excerpts,
    // file contents or the original exception in a user-visible error.
    super(`Claude was not started: ${reason}.`);
    this.name = "ClaudePrivacySettingsError";
    this.code = "AIMGR_CLAUDE_PRIVACY_SETTINGS";
  }
}

const fail = reason => { throw new ClaudePrivacySettingsError(reason); };

const OPTIONAL_VALUE_FLAGS = new Set(`-d --debug -r --resume --from-pr -w --worktree
--teleport --cloud --remote --project --remote-control --rc --prompt-suggestions`.split(/\s+/));
const VARIADIC_FLAGS = new Set(`--allowedTools --allowed-tools --disallowedTools --disallowed-tools
--tools --add-dir --mcp-config --betas --file --channels --dangerously-load-development-channels`.split(/\s+/));
const BOOLEAN_FLAGS = new Set(`-h --help -v --version -d2e --debug-to-stderr --verbose -p --print
--bare --safe-mode --init --init-only --maintenance --include-hook-events --include-partial-messages
--forward-subagent-text --session-mirror --await-claim --await-initialize --dangerously-skip-permissions
--allow-dangerously-skip-permissions --replay-user-messages --host-auth-is-org-sign-in --enable-auth-status
--restricted --allow-other-models --exclude-dynamic-system-prompt-sections --include-unsupported-models
-c --continue --fork-session --deep-link-origin --no-session-persistence --reply-on-resume --ide --desktop
--strict-mcp-config --disable-slash-commands --chrome --no-chrome --tmux --enable-auto-mode --bg --background
--agents-view-if-allowed --brief --ax-screen-reader --plan-mode-required --hard-fail`.split(/\s+/));
const COMMANDS = new Set(`gateway mcp edit-hook edit-permission-rules edit-memory-settings
edit-skill-overrides edit-sandbox-settings design-login edit-chrome-settings drop-worktree-registrations
purge project auth plugin plugins setup-token agents ultrareview auto-mode remote-control rc doctor
apply-project-settings sandbox update upgrade install import import-conversations`.split(/\s+/));
const AGENTS_REQUIRED = new Set(`--setting-sources --cwd --add-dir --plugin-dir --plugin-dir-no-mcp
--settings --managed-settings --mcp-config --permission-mode --inherit-permission-mode --model --effort --agent`.split(/\s+/));
const AGENTS_BOOLEAN = new Set(`-h --help --strict-mcp-config --restricted --dangerously-skip-permissions
--allow-dangerously-skip-permissions --json --all`.split(/\s+/));
const optionLike = text => text.length > 1 && text.startsWith("-");
const spanKey = span => `${span.index}:${span.offset ?? "value"}:${span.valueIndex ?? ""}`;

/** The reviewed build has TWO parsers. BS/fYe loads settings from raw argv
 * before Commander expands short clusters or dispatches a subcommand. Treat
 * them separately: canonicalizing '-pn' to '-p -n' changes native eager print
 * detection and can turn a subcommand into a prompt. Never do that rewrite.
 * T08/T15: retain original argv and locate only real option-value spans.
 */
export function inspectClaudeArguments(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) fail("the native arguments are invalid");
  const eager = [];
  let eagerPrint = false, eagerUri = false, eagerManagedSettings = false, eagerRestricted = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") break;
    eagerPrint ||= token === "-p" || token === "--print";
    eagerRestricted ||= token === "--restricted";
    eagerUri ||= token.startsWith("cc://") || token.startsWith("cc+unix://");
    eagerManagedSettings ||= token === "--managed-settings" || token.startsWith("--managed-settings=");
    if (token === "--settings" && index + 1 < args.length) {
      eager.push({ index, valueIndex: index + 1, value: args[index + 1] });
    } else if (token.startsWith("--settings=")) {
      eager.push({ index, offset: "--settings=".length, value: token.slice("--settings=".length) });
    }
    if (REQUIRED_VALUE_FLAGS.has(token) || token === "--settings") {
      index += 1;
      if (VARIADIC_FLAGS.has(token)) while (index + 1 < args.length && !optionLike(args[index + 1])) index += 1;
    } else if (OPTIONAL_VALUE_FLAGS.has(token) && index + 1 < args.length && !optionLike(args[index + 1])) index += 1;
  }
  const options = [], settings = [], optionValues = {};
  let selectedCommand = null, commandAfterDelimiter = false;
  const registration = !eagerPrint || eagerUri;
  function scan(items, agents = false) {
    let firstOperand, unknown = false, variadic = null;
    const required = agents ? AGENTS_REQUIRED : REQUIRED_VALUE_FLAGS;
    const optional = agents ? new Set() : OPTIONAL_VALUE_FLAGS;
    const booleans = agents ? AGENTS_BOOLEAN : BOOLEAN_FLAGS;
    const register = (flag, item, valueItem, offset) => {
      options.push(flag);
      const value = offset !== undefined ? args[item.index].slice(offset) : valueItem?.text;
      if (value !== undefined) (optionValues[flag] ??= []).push(value);
      if (flag === "--settings") {
        settings.push(offset === undefined
          ? { index: item.index, valueIndex: valueItem.index, value: valueItem.text }
          : { index: item.index, offset, value: args[item.index].slice(offset) });
      }
    };
    while (items.length) {
      const item = items.shift(), token = item.text;
      if (token === "--") {
        if (firstOperand === undefined && !unknown && !agents && registration && COMMANDS.has(items[0]?.text)) {
          selectedCommand = items[0].text; commandAfterDelimiter = true;
        }
        break;
      }
      if (variadic && !optionLike(token)) { (optionValues[variadic] ??= []).push(token); continue; }
      variadic = null;
      if (required.has(token) || token === "--settings" || optional.has(token) || booleans.has(token)) {
        if (required.has(token) || token === "--settings") {
          const value = items.shift();
          if (!value) fail("a native option is missing its required argument");
          register(token, item, value);
        } else if (optional.has(token)) {
          const value = items.length && !optionLike(items[0].text) ? items.shift() : undefined;
          register(token, item, value);
        } else register(token, item);
        if (!agents && VARIADIC_FLAGS.has(token)) variadic = token;
        continue;
      }
      if (token.length > 2 && token[0] === "-" && token[1] !== "-") {
        const short = token.slice(0, 2);
        if (required.has(short) || optional.has(short)) {
          register(short, item, undefined, args[item.index].length - token.length + 2);
          continue;
        }
        if (booleans.has(short)) {
          register(short, item);
          items.unshift({ index: item.index, text: "-" + token.slice(2) });
          continue;
        }
      }
      const equals = /^--[^=]+=/.exec(token);
      if (equals) {
        const flag = token.slice(0, equals[0].length - 1);
        if (required.has(flag) || optional.has(flag) || flag === "--settings") {
          register(flag, item, undefined, args[item.index].length - token.length + equals[0].length);
          continue;
        }
      }
      if (optionLike(token)) unknown = true;
      if (firstOperand === undefined && !unknown && !agents && registration && COMMANDS.has(token)) {
        selectedCommand = token;
        if (token === "agents") scan(items, true);
        break;
      }
      if (!unknown && firstOperand === undefined) firstOperand = token;
    }
  }
  scan(args.map((text, index) => ({ text, index })));
  const actual = new Set(settings.map(spanKey));
  // An eager source can be a literal child argument (e.g. MCP client ID) or
  // a value consumed by a short cluster. Rewriting it would change the task.
  // This ambiguity is a compatibility gate, not permission to alter a prompt.
  if (eager.some(span => !actual.has(spanKey(span)))) {
    fail("the arguments give --settings conflicting native meanings; use unambiguous full options");
  }
  return { settings, selectedSettings: eager.at(-1)?.value, options, optionValues, selectedCommand,
    commandAfterDelimiter, eagerPrint, eagerUri, eagerManagedSettings, eagerRestricted };
}

/** Refuse native relay bootstraps which bypass the ordinary root parser.
 * T09: this is an early, explicit failure, not the in-session enforcement.
 * The immutable disableRemoteControl setting still covers saved activation,
 * slash commands and normal Commander subcommands. Do not reject --remote:
 * that root option is the separate cloud workflow in the reviewed build.
 */
export function assertClaudeLocalInvocation(args) {
  const parsed = inspectClaudeArguments(args);
  // The excluded self-hosted runner uploads local diagnostics independently of
  // analytics opt-out. Refuse its bootstrap explicitly; prefixing settings must
  // not silently reinterpret it as an ordinary prompt. Likewise an additional
  // parent policy file is a separate native precedence tier, not flag settings.
  if (args[0] === "self-hosted-runner") fail("the self-hosted remote runner is outside the supported local Claude workflow");
  if (parsed.eagerManagedSettings || parsed.options.includes("--managed-settings")) {
    fail("an additional parent managed-settings source cannot override the admitted Claude policy");
  }
  if (["update", "upgrade", "install"].includes(parsed.selectedCommand)) {
    fail("Claude updates require a reviewed artifact and explicit activation through AI Manager's installer");
  }
  if (["remote-control", "rc", "remote", "sync", "bridge"].includes(args[0])) {
    fail("Remote Control is disabled for AI Manager Claude accounts");
  }
  if (["remote-control", "rc"].includes(parsed.selectedCommand)
    || parsed.options.some(flag => flag === "--remote-control" || flag === "--rc")) {
    fail("Remote Control is disabled for AI Manager Claude accounts");
  }
}

export function claudeCriticalSettings({ protectedAccount } = {}) {
  if (typeof protectedAccount !== "boolean") fail("the account privacy mode is unknown");
  return {
    disableRemoteControl: true,
    env: {
      DISABLE_AUTOUPDATER: "1",
      DISABLE_UPDATES: "1",
      // T08: telemetry opt-out normally disables GrowthBook, but an explicit
      // disk-cache opt-in can revive a cached policy flag. Both native builds
      // then treat stale profile-derived Pro credentials as policy-eligible.
      // The user explicitly accepted remote feature flags being disabled for
      // ALL AIM Claude accounts on 2026-11-01, including ordinary accounts.
      // Do not replace this with a freshness timer: suspension or a fresh
      // native child can expire profile provenance before eligibility runs.
      // Never rewrite provenance or clear caches to manufacture ineligibility.
      DISABLE_GROWTHBOOK: "1",
      ...(protectedAccount ? {
        DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
        // Reviewed 2.1.316 uses HOSTNAME only for an optional poller's worker
        // label (it has a UUID fallback). These three terminal variables only
        // select terminal-specific extras. Keep TERM and build/MCP credentials;
        // do not let lower settings restore machine/session identifiers (T07).
        HOSTNAME: "", TERMINATOR_UUID: "", TILIX_ID: "", GNOME_TERMINAL_SERVICE: "",
      } : {}),
    },
  };
}

function readSettings(value, cwd, nativeTempDirectory, fsImpl) {
  try {
    let text;
    let source;
    const inline = value.trim().startsWith("{") && value.trim().endsWith("}");
    if (inline) {
      text = value.trim();
      // Native CLI JSON is itself materialized in claude-<uid> beneath its
      // temporary root. It is NOT anchored to cwd. Keeping that directory
      // preserves sandbox/permission paths and configured-hook trust (T15).
      source = { kind: "inline", directory: nativeTempDirectory };
    }
    else {
      // Native resolves symlinks before recording the flag source. A sibling
      // of a symlink's spelling can have different permission/path semantics.
      const file = fsImpl.realpathSync(path.resolve(cwd, value));
      source = { kind: "file", path: file, directory: path.dirname(file) };
      const descriptor = fsImpl.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const stat = fsImpl.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) fail("the explicit settings source is not a bounded regular file");
        text = fsImpl.readFileSync(descriptor, "utf8");
      } finally { fsImpl.closeSync(descriptor); }
    }
    if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) fail("the explicit settings source is too large");
    // The native file loader strips one leading BOM and treats whitespace-only
    // files as an empty object. Preserve those accepted inputs; a wrapper-only
    // parse error would silently narrow the existing settings workflow (T15).
    const json = text.replace(/^\uFEFF/, "");
    const parsed = json.trim() === "" ? {} : JSON.parse(json);
    if (!object(parsed)) fail("the explicit settings source must contain a JSON object");
    return { settings: parsed, source };
  } catch (error) {
    if (error instanceof ClaudePrivacySettingsError) throw error;
    fail("the explicit settings source could not be read as a JSON object");
  }
}

/** Compose the ONE native flag-settings value without discarding AIM hooks.
 *
 * T08/T15/T18: on both audited 2.1.316 binaries, repeated --settings flags use
 * only the last value; appending a privacy flag silently loses earlier hooks.
 * A --settings file is a startup snapshot, unlike the normal user/project
 * sources whose unrelated live edits must remain live. Read only the selected
 * flag value and leave normal settings sources to Claude.
 *
 * The result contains private data: final launch code must transfer it through
 * a private protected file/descriptor, never JSON in argv, status or logs. This
 * pure preparation is NOT launch admission: native policy application, account
 * eligibility and managed-source conflict refusal must precede vendor exec.
 * The selected source directory is part of its semantics: native sandbox
 * paths can be relative to the original --settings file. Do not relocate the
 * returned settings without preserving those field-specific resolutions.
 *
 * Integration gate still open: native schema errors in unrelated fields can
 * discard this entire object, including critical values. JSON parsing here is
 * not native schema validation; a caller must not treat this as enforcement.
 */
export function composeClaudePrivacySettings({
  args = [],
  cwd,
  defaultFlagSettings = {},
  requiredHooks = {},
  providerEnvironment = {},
  protectedAccount,
  nativeTempDirectory = path.resolve(cwd ?? ".", process.env.CLAUDE_CODE_TMPDIR || os.tmpdir(), `claude-${process.getuid?.() ?? 0}`),
  fsImpl = fs,
} = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string") || !path.isAbsolute(cwd ?? "")
    || !path.isAbsolute(nativeTempDirectory)) {
    fail("the native arguments or working directory are invalid");
  }
  if (!object(defaultFlagSettings) || !object(requiredHooks) || !object(providerEnvironment)
    || Object.values(providerEnvironment).some(value => typeof value !== "string")) fail("the AIM settings are invalid");
  assertClaudeLocalInvocation(args);
  const selected = inspectClaudeArguments(args).selectedSettings;
  if (selected === "") fail("--settings requires a file or JSON object");
  const chosen = selected === undefined
    ? { settings: defaultFlagSettings, source: { kind: "default", directory: nativeTempDirectory } }
    : readSettings(selected, cwd, nativeTempDirectory, fsImpl);
  const settings = structuredClone(chosen.settings);
  if (settings.env !== undefined && !object(settings.env)) fail("the explicit settings env field is invalid");
  if (settings.hooks !== undefined && !object(settings.hooks)) fail("the explicit settings hooks field is invalid");
  const hasRequiredHooks = Object.values(requiredHooks).some(entries => Array.isArray(entries) && entries.length > 0);
  if (hasRequiredHooks && settings.disableAllHooks === true) {
    fail("disableAllHooks conflicts with the AIM lifecycle hooks required for this launch");
  }
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, entries] of Object.entries(requiredHooks)) {
    if (!REQUIRED_EVENTS.has(event) || !Array.isArray(entries) || !entries.every(object)
      || (hooks[event] !== undefined && !Array.isArray(hooks[event]))) {
      fail("the required AIM lifecycle hooks are invalid");
    }
    const existing = hooks[event] ?? [];
    const seen = new Set(existing.map(entry => JSON.stringify(entry)));
    hooks[event] = [...existing, ...structuredClone(entries).filter(entry => {
      const key = JSON.stringify(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })];
  }
  const critical = claudeCriticalSettings({ protectedAccount });
  const composed = {
    ...settings,
    ...(Object.keys(hooks).length ? { hooks } : {}),
    // T18: merely retaining hook arrays does not run them when a lower
    // settings source disables all hooks. An explicit conflicting flag above
    // refuses instead of silently changing the caller's requested behavior.
    ...(hasRequiredHooks ? { disableAllHooks: false } : {}),
    disableRemoteControl: critical.disableRemoteControl,
    // An empty higher-priority string disables a lower live API key helper.
    // Merely deleting a flag field would expose the lower helper again.
    ...(Object.keys(providerEnvironment).length ? { apiKeyHelper: "" } : {}),
    env: { ...(settings.env ?? {}), ...critical.env, ...providerEnvironment },
  };
  // Validate and transfer THESE exact compact bytes. A valid near-limit input
  // can overflow after adding required fields; native then drops the complete
  // source. Never truncate user fields or call that a harmless warning. The
  // near-limit compatibility case stays explicit in T15 until resolved.
  const serialized = JSON.stringify(composed);
  if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) {
    fail("the settings plus required privacy controls exceed Claude's 2 MiB settings-file limit");
  }
  return {
    // These still contain private user settings. Only the handoff may form
    // executable argv: it replaces settings values without rewriting clusters.
    args: [...args],
    source: chosen.source,
    settings: composed,
    serialized,
  };
}
