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
    json: false,
    compact: false,
    accounts: false,
    help: false,
    once: false,
    intervalSeconds: undefined,
    rotateBelow5hRemainingPct: undefined,
    pool: undefined,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
