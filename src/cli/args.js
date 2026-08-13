export const CLAUDE_OPUS_RUN_PRESET_ARGS = Object.freeze([
  "--dangerously-skip-permissions",
  "--model",
  "opus",
  "--effort",
  "max",
]);

export const CLAUDE_FABLE_RUN_PRESET_ARGS = Object.freeze([
  "--dangerously-skip-permissions",
  "--model",
  "claude-fable-5",
  "--effort",
  "xhigh",
]);

function claudeRunPresetArgs(value) {
  if (value === "opus") return CLAUDE_OPUS_RUN_PRESET_ARGS;
  if (value === "fable") return CLAUDE_FABLE_RUN_PRESET_ARGS;
  return null;
}

function expandClaudeRunPreset(argv) {
  if (argv[0] !== "claude" || argv[1] !== "run" || !argv[2]) {
    return { argv, autoSelect: false, autoSelectPreset: null };
  }
  const explicitPresetArgs = claudeRunPresetArgs(argv[3]);
  const autoPresetArgs = explicitPresetArgs ? null : claudeRunPresetArgs(argv[2]);
  const presetArgs = explicitPresetArgs ?? autoPresetArgs;
  if (!presetArgs) return { argv, autoSelect: false, autoSelectPreset: null };
  const prefixLength = autoPresetArgs ? 2 : 3;
  const tailIndex = autoPresetArgs ? 3 : 4;
  const tail = argv.slice(tailIndex);
  const passthroughTail = tail[0] === "--" ? tail.slice(1) : tail;
  return {
    argv: [...argv.slice(0, prefixLength), "--", ...presetArgs, ...passthroughTail],
    autoSelect: Boolean(autoPresetArgs),
    autoSelectPreset: autoPresetArgs ? argv[2] : null,
  };
}

export function parseArgs(argv) {
  const expandedClaudeRun = expandClaudeRunPreset(argv);
  argv = expandedClaudeRun.argv;
  const opts = {
    home: undefined,
    url: undefined,
    keyPrefix: undefined,
    primaryHost: undefined,
    transport: undefined,
    provider: undefined,
    codex: undefined,
    claude: undefined,
    grok: undefined,
    replaceNativeAuth: false,
    mode: undefined,
    seedFromOpenclaw: undefined,
    userDataDir: undefined,
    profile: undefined,
    session: undefined,
    authFile: undefined,
    inFile: undefined,
    outFile: undefined,
    sourceHome: undefined,
    sourceConfigDir: undefined,
    key: undefined,
    tier: undefined,
    subscription: undefined,
    notes: undefined,
    manualCallbackStdio: false,
    json: false,
    compact: false,
    accounts: false,
    help: false,
    once: false,
    fresh: false,
    verbose: false,
    confirm: false,
    intervalSeconds: undefined,
    rotateBelow5hRemainingPct: undefined,
    primeResumeRotate: false,
    pool: undefined,
    claudeAutoSelect: expandedClaudeRun.autoSelect,
    claudeAutoSelectPreset: expandedClaudeRun.autoSelectPreset,
    claudeResumeAccountLabel: undefined,
    claudeResumeSwitchAccountPreset: undefined,
    afterDoubleDash: [],
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      opts.afterDoubleDash = argv.slice(i + 1);
      break;
    }
    if (arg === "--home") {
      opts.home = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--url") {
      opts.url = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--key-prefix") {
      opts.keyPrefix = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--primary-host") {
      opts.primaryHost = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--transport") {
      opts.transport = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--provider") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--provider requires a provider id.");
      }
      opts.provider = value;
      i += 1;
      continue;
    }
    if (arg === "--codex" || arg === "--claude" || arg === "--grok") {
      if ((argv[0] !== "pi" && argv[0] !== "prime") || argv[1] !== "use") {
        throw new Error(`Unknown option: ${arg}`);
      }
      if (arg === "--grok" && argv[0] !== "prime") {
        throw new Error("Unknown option: --grok");
      }
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(
          arg === "--codex"
            ? "--codex requires auto, an exact label, or off."
            : arg === "--claude"
              ? "--claude requires fable, opus, an exact label, or off."
              : "--grok requires auto, an exact label, or off.",
        );
      }
      if (arg === "--codex") opts.codex = value;
      else if (arg === "--claude") opts.claude = value;
      else opts.grok = value;
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      opts.mode = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--seed-from-openclaw") {
      opts.seedFromOpenclaw = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--user-data-dir") {
      opts.userDataDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--profile-directory") {
      opts.profileDirectory = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--profile") {
      opts.profile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--session") {
      opts.session = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--auth-file") {
      opts.authFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--in") {
      opts.inFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--out") {
      opts.outFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--source-home") {
      opts.sourceHome = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--source-config-dir") {
      opts.sourceConfigDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--key") {
      opts.key = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--tier") {
      opts.tier = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--subscription") {
      opts.subscription = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--notes") {
      opts.notes = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--manual-callback-stdio") {
      opts.manualCallbackStdio = true;
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--compact") {
      opts.compact = true;
      continue;
    }
    if (arg === "--accounts") {
      opts.accounts = true;
      continue;
    }
    if (arg === "--assignments") {
      opts.assignments = true;
      continue;
    }
    if (arg === "--pool") {
      opts.pool = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--once") {
      opts.once = true;
      continue;
    }
    if (arg === "--fresh") {
      opts.fresh = true;
      continue;
    }
    if (arg === "--verbose") {
      if (argv[0] !== "claude" || (argv[1] !== "status" && argv[1] !== "usage")) {
        throw new Error("Unknown option: --verbose");
      }
      opts.verbose = true;
      continue;
    }
    if (arg === "--account") {
      if (argv[0] !== "claude" || argv[1] !== "resume") {
        throw new Error("Unknown option: --account");
      }
      const label = argv[i + 1];
      if (!label || label.startsWith("--")) {
        throw new Error("--account requires a Claude account label.");
      }
      opts.claudeResumeAccountLabel = label;
      i += 1;
      continue;
    }
    if (arg === "--switch-account") {
      if (argv[0] !== "claude" || argv[1] !== "resume") {
        throw new Error("Unknown option: --switch-account");
      }
      const preset = argv[i + 1];
      if (preset !== "fable" && preset !== "opus") {
        throw new Error("--switch-account requires fable or opus.");
      }
      opts.claudeResumeSwitchAccountPreset = preset;
      i += 1;
      continue;
    }
    if (arg === "--confirm") {
      opts.confirm = true;
      continue;
    }
    if (arg === "--interval-seconds") {
      opts.intervalSeconds = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--rotate-below-5h-remaining-pct") {
      opts.rotateBelow5hRemainingPct = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--rotate" && argv[0] === "prime" && argv[1] === "resume") {
      opts.primeResumeRotate = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (
      arg.startsWith("-")
      && argv[0] === "claude"
      && (argv[1] === "run" || argv[1] === "resume")
    ) {
      opts.afterDoubleDash = argv.slice(i);
      break;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  return { opts, positional };
}
