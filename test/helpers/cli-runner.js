import { main } from "../../src/cli.js";

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
