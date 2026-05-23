export function parseArgs(argv) {
  const opts = {
    home: undefined,
    state: undefined,
    from: undefined,
    to: undefined,
    mode: undefined,
    seedFromOpenclaw: undefined,
    userDataDir: undefined,
    profile: undefined,
    session: undefined,
    authFile: undefined,
    inFile: undefined,
    outFile: undefined,
    sourceHome: undefined,
    discardDirty: false,
    manualCallbackStdio: false,
    json: false,
    compact: false,
    accounts: false,
    help: false,
    once: false,
    tend: false,
    noAttach: false,
    intervalSeconds: undefined,
    rotateBelow5hRemainingPct: undefined,
    pool: undefined,
    tmuxSession: undefined,
    codexBin: undefined,
    codexProfile: undefined,
    maxRestarts: undefined,
    pollSeconds: undefined,
    promptTimeoutSeconds: undefined,
    workdir: undefined,
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
    if (arg === "--state") {
      opts.state = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--from") {
      opts.from = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--to") {
      opts.to = argv[i + 1];
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
    if (arg === "--discard-dirty") {
      opts.discardDirty = true;
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
    if (arg === "--tend") {
      opts.tend = true;
      continue;
    }
    if (arg === "--no-attach") {
      opts.noAttach = true;
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
    if (arg === "--tmux-session") {
      opts.tmuxSession = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--codex-bin") {
      opts.codexBin = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "-p" || arg === "--codex-profile") {
      opts.codexProfile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--max-restarts") {
      opts.maxRestarts = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--poll-seconds") {
      opts.pollSeconds = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--prompt-timeout-seconds") {
      opts.promptTimeoutSeconds = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--workdir") {
      opts.workdir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  return { opts, positional };
}
