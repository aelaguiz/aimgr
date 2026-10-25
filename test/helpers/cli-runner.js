import { main } from "../../src/cli.js";

const redisFixtureDepsByHome = new Map();

export function registerCliRedisFixture(homeDir, deps) {
  redisFixtureDepsByHome.set(String(homeDir), deps);
}

function fixtureDepsForArgv(argv, deps) {
  const homeIndex = argv.indexOf("--home");
  const homeDir = homeIndex >= 0
    ? argv[homeIndex + 1]
    : deps?.env?.HOME ?? process.env.HOME;
  return redisFixtureDepsByHome.get(String(homeDir)) ?? {};
}

function createCaptureStdout(chunks, stdout = {}) {
  return {
    ...(stdout && typeof stdout === "object" ? stdout : {}),
    write: (chunk, encoding, cb) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString(encoding));
      if (typeof cb === "function") cb();
      return true;
    },
  };
}

export async function runCli(argv, deps = {}) {
  deps = testDeps(argv, deps);
  const chunks = [];
  const stdout = createCaptureStdout(chunks, deps.stdout);
  const wrappedDeps =
    typeof deps.promptLineImpl === "function"
      ? {
          ...deps,
          promptLineImpl: async (...args) => {
            const answer = await deps.promptLineImpl(...args);
            if (answer === undefined) {
              throw new Error(`test prompt exhausted for: ${String(args[0] ?? "").trim() || "<unknown prompt>"}`);
            }
            return answer;
          },
        }
      : deps;
  await main(argv, { ...wrappedDeps, stdout });
  return chunks.join("");
}

export async function runCliWithExitCode(argv, deps = {}) {
  deps = testDeps(argv, deps);
  const chunks = [];
  let exitCode = 0;
  const stdout = createCaptureStdout(chunks, deps.stdout);
  const wrappedDeps =
    typeof deps.promptLineImpl === "function"
      ? {
          ...deps,
          promptLineImpl: async (...args) => {
            const answer = await deps.promptLineImpl(...args);
            if (answer === undefined) {
              throw new Error(`test prompt exhausted for: ${String(args[0] ?? "").trim() || "<unknown prompt>"}`);
            }
            return answer;
          },
        }
      : deps;
  await main(argv, {
    ...wrappedDeps,
    stdout,
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  return { stdout: chunks.join(""), exitCode };
}

function testDeps(argv, deps) {
  const merged = { ...fixtureDepsForArgv(argv, deps), ...deps };
  // A developer often runs tests from an AIM-managed session. Never let its
  // real auth-directory overrides escape the test's --home fixture. Tests that
  // exercise an override must supply it explicitly through deps.env.
  return {
    ...merged,
    env: merged.env ?? {
      ...process.env,
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
      PRIME_AGENT_CODING_AGENT_DIR: "",
      CLAUDE_CONFIG_DIR: "",
    },
  };
}
